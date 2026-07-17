import { useEffect, useRef } from "react";

import { useTheme } from "@/renderer/providers/ThemeProvider";
import { prefersReducedMotion } from "@/renderer/utils/motionPreference";

const PARTICLE_COUNT = 10_000;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const REFERENCE_FPS = 60;
const SPEED_NORMALIZED = 20 / 10;
const SMOOTHING_NORMALIZED = 7 / 10;
const DRAG_SPEED_NORMALIZED = 5 / 10;
const CURSOR_STRENGTH = 15;
const CURSOR_RADIUS = 75;
const CLICK_FORCE = 5;
const RETURN_FORCE = 0.015;
const FRICTION = 0.94;
const ROTATION_SPEED = mapLinear(SPEED_NORMALIZED, 0.1, 1, 0.01, 0.05);
const ROTATION_LERP_FACTOR = mapLinear(SMOOTHING_NORMALIZED, 0, 1, 0.4, 0.03);
const ROTATION_VELOCITY_DECAY = mapLinear(SMOOTHING_NORMALIZED, 0, 1, 0.7, 0.96);
const AUTO_ROTATION_SPEED = ROTATION_SPEED * 0.1 * REFERENCE_FPS;
const DRAG_SENSITIVITY = mapLinear(DRAG_SPEED_NORMALIZED, 0, 1, 0.001, 0.02);
const MAX_PITCH = Math.PI * 0.34;
const HOVER_PUSH_PER_SECOND = CURSOR_STRENGTH * SPEED_NORMALIZED * 0.01 * REFERENCE_FPS;
const DISPLACEMENT_RETURN_RATE = -Math.log(FRICTION * (1 - RETURN_FORCE * SPEED_NORMALIZED)) * REFERENCE_FPS;
const SCATTER_VELOCITY_DECAY = -Math.log(0.95 * (1 - RETURN_FORCE * SPEED_NORMALIZED)) * REFERENCE_FPS;
const ROTATION_FOLLOW_RATE = -Math.log(1 - ROTATION_LERP_FACTOR) * REFERENCE_FPS;
const ROTATION_THROW_DECAY_RATE = -Math.log(ROTATION_VELOCITY_DECAY) * REFERENCE_FPS;
const CLICK_IMPULSE_PER_SECOND = CLICK_FORCE * 0.5 * 0.1 * REFERENCE_FPS;

interface ParticleField {
  readonly baseX: Float32Array;
  readonly baseY: Float32Array;
  readonly baseZ: Float32Array;
  readonly displacementX: Float32Array;
  readonly displacementY: Float32Array;
  readonly displacementZ: Float32Array;
  readonly velocityX: Float32Array;
  readonly velocityY: Float32Array;
  readonly velocityZ: Float32Array;
  readonly screenX: Float32Array;
  readonly screenY: Float32Array;
  readonly restScreenX: Float32Array;
  readonly restScreenY: Float32Array;
  readonly screenDepth: Float32Array;
  readonly screenScale: Float32Array;
  readonly depthBucket: Uint8Array;
  readonly cursorAccent: Uint8Array;
}

interface PointerState {
  active: boolean;
  pressed: boolean;
  dragging: boolean;
  pointerId: number | null;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  lastMoveAt: number;
  travel: number;
}

export function ProductParticleSphere() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context || typeof context.clearRect !== "function") {
      return;
    }

    const field = createParticleField(PARTICLE_COUNT);
    const rootStyles = getComputedStyle(document.documentElement);
    const particleColor = rootStyles.getPropertyValue("--color-text-1").trim() || (theme === "dark" ? "#f8f8f2" : "#171717");
    const accentColor = rootStyles.getPropertyValue("--color-primary-6").trim() || (theme === "dark" ? "#ff79c6" : "#1677ff");
    const reducedMotion = prefersReducedMotion();
    const pointer: PointerState = {
      active: false,
      pressed: false,
      dragging: false,
      pointerId: null,
      x: 0,
      y: 0,
      lastX: 0,
      lastY: 0,
      lastMoveAt: 0,
      travel: 0,
    };

    let width = 0;
    let height = 0;
    let deviceScale = 1;
    let frameId = 0;
    let lastFrameAt = performance.now();
    let currentYaw = -0.38;
    let targetYaw = currentYaw;
    let currentPitch = -0.18;
    let targetPitch = currentPitch;
    let throwYaw = 0;
    let throwPitch = 0;

    const updatePointerCoordinates = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      pointer.x = event.clientX - bounds.left;
      pointer.y = event.clientY - bounds.top;
      pointer.active = pointer.x >= 0 && pointer.x <= bounds.width && pointer.y >= 0 && pointer.y <= bounds.height;
    };

    const handlePointerMove = (event: PointerEvent) => {
      updatePointerCoordinates(event);
      if (!pointer.pressed || reducedMotion) {
        return;
      }
      const now = performance.now();
      const elapsedSeconds = Math.max((now - pointer.lastMoveAt) / 1_000, 1 / 240);
      const deltaX = event.clientX - pointer.lastX;
      const deltaY = event.clientY - pointer.lastY;
      pointer.travel += Math.hypot(deltaX, deltaY);
      if (!pointer.dragging && pointer.travel >= 4) {
        pointer.dragging = true;
        throwYaw = 0;
        throwPitch = 0;
        canvas.dataset.dragging = "true";
      }
      if (pointer.dragging) {
        targetYaw += deltaX * DRAG_SENSITIVITY;
        targetPitch = clamp(targetPitch + deltaY * DRAG_SENSITIVITY, -MAX_PITCH, MAX_PITCH);
        throwYaw = (deltaX * DRAG_SENSITIVITY) / elapsedSeconds * 0.3;
        throwPitch = (deltaY * DRAG_SENSITIVITY) / elapsedSeconds * 0.3;
      }
      pointer.lastX = event.clientX;
      pointer.lastY = event.clientY;
      pointer.lastMoveAt = now;
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      updatePointerCoordinates(event);
      pointer.pressed = true;
      pointer.dragging = false;
      pointer.pointerId = event.pointerId;
      pointer.lastX = event.clientX;
      pointer.lastY = event.clientY;
      pointer.lastMoveAt = performance.now();
      pointer.travel = 0;
      canvas.setPointerCapture?.(event.pointerId);
    };

    const finishPointer = (event: PointerEvent, allowScatter: boolean) => {
      if (!pointer.pressed || (pointer.pointerId !== null && pointer.pointerId !== event.pointerId)) {
        return;
      }
      updatePointerCoordinates(event);
      if (allowScatter && !reducedMotion && !pointer.dragging && pointer.travel < 7) {
        scatterParticles(field, pointer.x, pointer.y, currentYaw, currentPitch, spherePixelRadius(width, height));
      }
      pointer.pressed = false;
      pointer.dragging = false;
      pointer.pointerId = null;
      delete canvas.dataset.dragging;
      if (canvas.hasPointerCapture?.(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };

    const handlePointerUp = (event: PointerEvent) => finishPointer(event, true);
    const handlePointerCancel = (event: PointerEvent) => finishPointer(event, false);
    const handlePointerLeave = () => {
      if (!pointer.pressed) {
        pointer.active = false;
      }
    };

    const drawFrame = (now: number) => {
      const deltaSeconds = clamp((now - lastFrameAt) / 1_000, 0, 1 / 30);
      lastFrameAt = now;

      if (!reducedMotion) {
        if (!pointer.dragging) {
          targetYaw += (AUTO_ROTATION_SPEED + throwYaw) * deltaSeconds;
          targetPitch = clamp(targetPitch + throwPitch * deltaSeconds, -MAX_PITCH, MAX_PITCH);
          const throwDecay = Math.exp(-ROTATION_THROW_DECAY_RATE * deltaSeconds);
          throwYaw *= throwDecay;
          throwPitch *= throwDecay;
        }
        const rotationFollow = 1 - Math.exp(-ROTATION_FOLLOW_RATE * deltaSeconds);
        currentYaw += shortestAngle(targetYaw - currentYaw) * rotationFollow;
        currentPitch += (targetPitch - currentPitch) * rotationFollow;
      }

      renderParticleField({
        context,
        field,
        width,
        height,
        deltaSeconds,
        yaw: currentYaw,
        pitch: currentPitch,
        pointer: reducedMotion ? null : pointer,
        particleColor,
        accentColor,
      });
      if (!reducedMotion && !document.hidden) {
        frameId = window.requestAnimationFrame(drawFrame);
      }
    };

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      deviceScale = Math.min(window.devicePixelRatio || 1, 2);
      const nextWidth = Math.max(1, Math.round(width * deviceScale));
      const nextHeight = Math.max(1, Math.round(height * deviceScale));
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
      context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
      lastFrameAt = performance.now();
      if (reducedMotion) {
        renderParticleField({
          context,
          field,
          width,
          height,
          deltaSeconds: 0,
          yaw: currentYaw,
          pitch: currentPitch,
          pointer: null,
          particleColor,
          accentColor,
        });
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden || reducedMotion) {
        window.cancelAnimationFrame(frameId);
        return;
      }
      lastFrameAt = performance.now();
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(drawFrame);
    };

    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    resizeObserver?.observe(canvas);
    window.addEventListener("resize", resize);
    resize();
    if (!reducedMotion) {
      frameId = window.requestAnimationFrame(drawFrame);
    }

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [theme]);

  return (
    <canvas
      ref={canvasRef}
      className="product-particle-sphere"
      data-testid="product-particle-sphere"
      role="img"
      aria-label="可交互的 Keydex 粒子球"
    />
  );
}

function createParticleField(count: number): ParticleField {
  const field: ParticleField = {
    baseX: new Float32Array(count),
    baseY: new Float32Array(count),
    baseZ: new Float32Array(count),
    displacementX: new Float32Array(count),
    displacementY: new Float32Array(count),
    displacementZ: new Float32Array(count),
    velocityX: new Float32Array(count),
    velocityY: new Float32Array(count),
    velocityZ: new Float32Array(count),
    screenX: new Float32Array(count),
    screenY: new Float32Array(count),
    restScreenX: new Float32Array(count),
    restScreenY: new Float32Array(count),
    screenDepth: new Float32Array(count),
    screenScale: new Float32Array(count),
    depthBucket: new Uint8Array(count),
    cursorAccent: new Uint8Array(count),
  };

  for (let index = 0; index < count; index += 1) {
    const y = 1 - (index / (count - 1)) * 2;
    const horizontalRadius = Math.sqrt(1 - y * y);
    const angle = GOLDEN_ANGLE * index;
    field.baseX[index] = Math.cos(angle) * horizontalRadius;
    field.baseY[index] = y;
    field.baseZ[index] = Math.sin(angle) * horizontalRadius;
  }
  return field;
}

interface RenderParticleFieldOptions {
  context: CanvasRenderingContext2D;
  field: ParticleField;
  width: number;
  height: number;
  deltaSeconds: number;
  yaw: number;
  pitch: number;
  pointer: PointerState | null;
  particleColor: string;
  accentColor: string;
}

function renderParticleField({
  context,
  field,
  width,
  height,
  deltaSeconds,
  yaw,
  pitch,
  pointer,
  particleColor,
  accentColor,
}: RenderParticleFieldOptions) {
  context.clearRect(0, 0, width, height);
  if (width <= 1 || height <= 1) {
    return;
  }

  const centerX = width / 2;
  const centerY = height / 2;
  const pixelRadius = spherePixelRadius(width, height);
  const cursorRadius = CURSOR_RADIUS;
  const cursorRadiusSquared = cursorRadius * cursorRadius;
  const returnDecay = Math.exp(-DISPLACEMENT_RETURN_RATE * deltaSeconds);
  const velocityDecay = Math.exp(-SCATTER_VELOCITY_DECAY * deltaSeconds);
  const cosineYaw = Math.cos(yaw);
  const sineYaw = Math.sin(yaw);
  const cosinePitch = Math.cos(pitch);
  const sinePitch = Math.sin(pitch);

  for (let index = 0; index < field.baseX.length; index += 1) {
    field.displacementX[index] = (field.displacementX[index] + field.velocityX[index] * deltaSeconds) * returnDecay;
    field.displacementY[index] = (field.displacementY[index] + field.velocityY[index] * deltaSeconds) * returnDecay;
    field.displacementZ[index] = (field.displacementZ[index] + field.velocityZ[index] * deltaSeconds) * returnDecay;
    field.velocityX[index] *= velocityDecay;
    field.velocityY[index] *= velocityDecay;
    field.velocityZ[index] *= velocityDecay;

    const restYawX = cosineYaw * field.baseX[index] + sineYaw * field.baseZ[index];
    const restYawZ = -sineYaw * field.baseX[index] + cosineYaw * field.baseZ[index];
    const restViewY = cosinePitch * field.baseY[index] - sinePitch * restYawZ;
    const restViewZ = sinePitch * field.baseY[index] + cosinePitch * restYawZ;
    const restPerspective = 1 / (1 - restViewZ * 0.2);
    field.restScreenX[index] = centerX + restYawX * pixelRadius * restPerspective;
    field.restScreenY[index] = centerY - restViewY * pixelRadius * restPerspective;

    const localX = field.baseX[index] + field.displacementX[index];
    const localY = field.baseY[index] + field.displacementY[index];
    const localZ = field.baseZ[index] + field.displacementZ[index];
    const yawX = cosineYaw * localX + sineYaw * localZ;
    const yawZ = -sineYaw * localX + cosineYaw * localZ;
    const viewY = cosinePitch * localY - sinePitch * yawZ;
    const viewZ = sinePitch * localY + cosinePitch * yawZ;
    const perspective = 1 / (1 - viewZ * 0.2);
    const screenX = centerX + yawX * pixelRadius * perspective;
    const screenY = centerY - viewY * pixelRadius * perspective;
    const depth = clamp((viewZ + 1.25) / 2.5, 0, 0.999);

    field.screenX[index] = screenX;
    field.screenY[index] = screenY;
    field.screenDepth[index] = viewZ;
    field.screenScale[index] = perspective;
    field.depthBucket[index] = Math.min(5, Math.floor(depth * 6));
    field.cursorAccent[index] = 0;

    if (pointer?.active && viewZ > 0) {
      const deltaX = screenX - pointer.x;
      const deltaY = screenY - pointer.y;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY;
      if (distanceSquared < cursorRadiusSquared && distanceSquared > 0.01) {
        const distance = Math.sqrt(distanceSquared);
        const influence = 1 - distance / cursorRadius;
        const push = influence * HOVER_PUSH_PER_SECOND * deltaSeconds;
        const viewPushX = (deltaX / distance) * push;
        const viewPushY = (-deltaY / distance) * push;
        const [localPushX, localPushY, localPushZ] = viewVectorToLocal(
          viewPushX,
          viewPushY,
          0,
          cosineYaw,
          sineYaw,
          cosinePitch,
          sinePitch,
        );
        field.displacementX[index] += localPushX;
        field.displacementY[index] += localPushY;
        field.displacementZ[index] += localPushZ;
        field.cursorAccent[index] = influence > 0.18 ? 1 : 0;
      }
    }
  }

  context.fillStyle = particleColor;
  for (let bucket = 0; bucket < 6; bucket += 1) {
    context.globalAlpha = 0.18 + bucket * 0.135;
    const size = 0.92 + bucket * 0.22;
    const offset = size / 2;
    for (let index = 0; index < field.baseX.length; index += 1) {
      if (field.depthBucket[index] !== bucket) {
        continue;
      }
      context.fillRect(field.screenX[index] - offset, field.screenY[index] - offset, size, size);
    }
  }

  context.fillStyle = accentColor;
  context.globalAlpha = 0.52;
  for (let index = 0; index < field.baseX.length; index += 1) {
    if (!field.cursorAccent[index]) {
      continue;
    }
    context.fillRect(field.screenX[index] - 0.9, field.screenY[index] - 0.9, 1.8, 1.8);
  }
  context.globalAlpha = 1;
}

function scatterParticles(
  field: ParticleField,
  pointerX: number,
  pointerY: number,
  yaw: number,
  pitch: number,
  pixelRadius: number,
) {
  const cursorRadius = CURSOR_RADIUS;
  const cosineYaw = Math.cos(yaw);
  const sineYaw = Math.sin(yaw);
  const cosinePitch = Math.cos(pitch);
  const sinePitch = Math.sin(pitch);

  for (let index = 0; index < field.baseX.length; index += 1) {
    const restDeltaX = field.restScreenX[index] - pointerX;
    const restDeltaY = field.restScreenY[index] - pointerY;
    const distance = Math.hypot(restDeltaX, restDeltaY);
    if (distance <= 0.01 || distance >= cursorRadius) {
      continue;
    }
    const influence = 1 - distance / cursorRadius;
    const perspective = Math.max(0.6, field.screenScale[index]);
    const viewDirectionX = (field.screenX[index] - pointerX) / (pixelRadius * perspective);
    const viewDirectionY = -(field.screenY[index] - pointerY) / (pixelRadius * perspective);
    const viewDirectionZ = field.screenDepth[index] * 0.76;
    const directionLength = Math.hypot(viewDirectionX, viewDirectionY, viewDirectionZ) || 1;
    const impulse = influence * CLICK_IMPULSE_PER_SECOND;
    const [localVelocityX, localVelocityY, localVelocityZ] = viewVectorToLocal(
      (viewDirectionX / directionLength) * impulse,
      (viewDirectionY / directionLength) * impulse,
      (viewDirectionZ / directionLength) * impulse,
      cosineYaw,
      sineYaw,
      cosinePitch,
      sinePitch,
    );
    field.velocityX[index] += localVelocityX;
    field.velocityY[index] += localVelocityY;
    field.velocityZ[index] += localVelocityZ;
  }
}

function viewVectorToLocal(
  viewX: number,
  viewY: number,
  viewZ: number,
  cosineYaw: number,
  sineYaw: number,
  cosinePitch: number,
  sinePitch: number,
): [number, number, number] {
  const yawSpaceY = cosinePitch * viewY + sinePitch * viewZ;
  const yawSpaceZ = -sinePitch * viewY + cosinePitch * viewZ;
  return [
    cosineYaw * viewX - sineYaw * yawSpaceZ,
    yawSpaceY,
    sineYaw * viewX + cosineYaw * yawSpaceZ,
  ];
}

function spherePixelRadius(width: number, height: number): number {
  return clamp(Math.min(width, height) * 0.355, 132, 292);
}

function shortestAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function mapLinear(value: number, inputMinimum: number, inputMaximum: number, outputMinimum: number, outputMaximum: number) {
  if (inputMaximum === inputMinimum) {
    return outputMinimum;
  }
  const progress = (value - inputMinimum) / (inputMaximum - inputMinimum);
  return outputMinimum + progress * (outputMaximum - outputMinimum);
}
