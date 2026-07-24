import {
  animate,
  motion,
  motionValue,
  useMotionValue,
  useSpring,
  useTransform,
  type MotionValue,
  type SpringOptions,
} from "motion/react";
import { CircleOff } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "@/renderer/providers/ThemeProvider";
import { prefersReducedMotion } from "@/renderer/utils/motionPreference";

import {
  PROJECT_ICON_COLOR_OPTIONS,
  projectIconSwatchValue,
  type ProjectIconColorId,
  type ProjectIconColorOption,
} from "./projectIconColors";
import styles from "./ProjectIconColorPicker.module.css";

export interface ProjectIconColorPickerProps {
  value: ProjectIconColorId | null;
  onChange: (value: ProjectIconColorId | null) => void;
}

interface ColorDotDescriptor {
  ring: number;
  index: number;
  totalInRing: number;
  option: ProjectIconColorOption;
}

interface PointerCoordinates {
  x: number;
  y: number;
}

const PUSH_MAGNITUDE = 5;
const PUSH_SPRING: SpringOptions = {
  damping: 30,
  stiffness: 100,
};
const CENTER_OPTION = PROJECT_ICON_COLOR_OPTIONS.find((option) => option.ring === "center");
const SOFT_OPTIONS = PROJECT_ICON_COLOR_OPTIONS.filter((option) => option.ring === "soft");
const VIVID_OPTIONS = PROJECT_ICON_COLOR_OPTIONS.filter((option) => option.ring === "vivid");

export function ProjectIconColorPicker({ value, onChange }: ProjectIconColorPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [{ centerX, centerY, radius }, setContainerDimensions] = useState({
    centerX: 0,
    centerY: 0,
    radius: 200,
  });
  const pointerPosition = usePointerPosition();
  const { theme } = useTheme();
  const reduceMotion = prefersReducedMotion();
  const selectedColor = projectIconSwatchValue(value, theme) ?? null;
  const originalStopValues = useMemo(() => {
    const values: string[] = VIVID_OPTIONS.map((option) =>
      theme === "dark" ? option.darkSwatch : option.lightSwatch,
    );
    if (values.length > 0) {
      values.push(values[0]);
    }
    return values;
  }, [theme]);
  const stopMotionValuesRef = useRef<MotionValue<string>[] | null>(null);
  if (stopMotionValuesRef.current === null) {
    stopMotionValuesRef.current = originalStopValues.map((color) => motionValue(color));
  }
  const stopMotionValues = stopMotionValuesRef.current;
  const gradientScale = useMotionValue(1);
  const gradientBackground = useTransform(() => {
    return `conic-gradient(from 0deg, ${stopMotionValues.map((stop) => stop.get()).join(", ")})`;
  });
  const dots = useMemo<ColorDotDescriptor[]>(() => {
    if (!CENTER_OPTION) {
      return [];
    }
    return [
      { ring: 0, index: 0, totalInRing: 1, option: CENTER_OPTION },
      ...SOFT_OPTIONS.map((option, index) => ({
        ring: 1,
        index,
        totalInRing: SOFT_OPTIONS.length,
        option,
      })),
      ...VIVID_OPTIONS.map((option, index) => ({
        ring: 2,
        index,
        totalInRing: VIVID_OPTIONS.length,
        option,
      })),
    ];
  }, []);

  useLayoutEffect(() => {
    if (!containerRef.current) {
      return;
    }
    const rect = containerRef.current.getBoundingClientRect();
    setContainerDimensions({
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      radius: rect.width / 2,
    });
  }, []);

  useEffect(() => {
    const animations = stopMotionValues.map((stopValue, index) =>
      animate(stopValue, selectedColor ?? originalStopValues[index], {
        duration: reduceMotion ? 0 : 0.2,
      }),
    );
    return () => {
      animations.forEach((animation) => animation.stop());
    };
  }, [originalStopValues, reduceMotion, selectedColor, stopMotionValues]);

  useEffect(() => {
    if (reduceMotion) {
      gradientScale.set(selectedColor !== null ? 1.05 : 1);
      return;
    }
    const animation = selectedColor !== null
      ? animate(gradientScale, 1.05, {
          type: "spring",
          visualDuration: 0.2,
          bounce: 0.8,
          velocity: 2,
        })
      : animate(gradientScale, 1, {
          type: "spring",
          visualDuration: 0.2,
          bounce: 0,
        });
    return () => animation.stop();
  }, [gradientScale, reduceMotion, selectedColor]);

  return (
    <div aria-label="选择项目图标颜色" className={styles.pickerShell} role="group">
      <div className={styles.gradientWrapper}>
        <div className={styles.background} aria-hidden="true">
          <motion.div
            className={styles.gradientBackground}
            style={{
              background: gradientBackground,
              scale: gradientScale,
            }}
          />
          <motion.div
            animate={{ scale: selectedColor !== null ? 0.95 : 0.99 }}
            className={styles.solidBackground}
            transition={
              reduceMotion
                ? { duration: 0 }
                : {
                    type: "spring",
                    visualDuration: 0.2,
                    bounce: 0.2,
                  }
            }
          />
        </div>
        <div className={styles.pickerBackground} ref={containerRef}>
          {SOFT_OPTIONS.map((option, index) => (
            <GradientCircle
              centerX={centerX}
              centerY={centerY}
              containerRadius={radius}
              index={index}
              key={`gradient-${option.id}`}
              color={theme === "dark" ? option.darkSwatch : option.lightSwatch}
              pointerPosition={pointerPosition}
              reduceMotion={reduceMotion}
              totalInRing={SOFT_OPTIONS.length}
            />
          ))}
          {dots
            .slice()
            .reverse()
            .map((dot) => (
              <ColorDot
                centerX={centerX}
                centerY={centerY}
                index={dot.index}
                key={dot.option.id}
                onSelect={() => onChange(value === dot.option.id ? null : dot.option.id as ProjectIconColorId)}
                option={dot.option}
                theme={theme}
                pointerPosition={pointerPosition}
                pushMagnitude={reduceMotion ? 0 : PUSH_MAGNITUDE}
                pushSpring={PUSH_SPRING}
                radius={radius}
                reduceMotion={reduceMotion}
                ring={dot.ring}
                totalInRing={dot.totalInRing}
              />
            ))}
        </div>
      </div>
      <button
        className={styles.clearButton}
        disabled={value === null}
        onClick={() => onChange(null)}
        type="button"
      >
        <CircleOff aria-hidden="true" className={styles.clearIcon} size={13} />
        <span>移除颜色</span>
      </button>
    </div>
  );
}

function ColorDot({
  ring,
  index,
  totalInRing,
  centerX,
  centerY,
  pointerPosition,
  pushMagnitude,
  pushSpring,
  radius,
  option,
  theme,
  onSelect,
  reduceMotion,
}: {
  ring: number;
  index: number;
  totalInRing: number;
  centerX: number;
  centerY: number;
  pointerPosition: MotionValue<PointerCoordinates>;
  pushMagnitude: number;
  pushSpring: SpringOptions;
  radius: number;
  option: ProjectIconColorOption;
  theme: "light" | "dark";
  onSelect: () => void;
  reduceMotion: boolean;
}) {
  const baseRadius = ring * 20;
  const angle = calculateAngle(index, totalInRing);
  const { x: baseX, y: baseY } = calculateBasePosition(angle, baseRadius);
  const pushDistance = useTransform(() => {
    if (centerX === 0 || centerY === 0) {
      return 0;
    }
    const { x: px, y: py } = pointerPosition.get();
    const dx = px - centerX;
    const dy = py - centerY;
    const distanceFromCenter = Math.sqrt(dx * dx + dy * dy);
    if (distanceFromCenter > radius) {
      return 0;
    }
    const dotX = centerX + baseX;
    const dotY = centerY + baseY;
    const cursorToDotX = dotX - px;
    const cursorToDotY = dotY - py;
    const cursorToDotDistance = Math.sqrt(
      cursorToDotX * cursorToDotX + cursorToDotY * cursorToDotY,
    );
    const minDistance = 80;
    if (cursorToDotDistance < minDistance) {
      const pushStrength = 1 - cursorToDotDistance / minDistance;
      return pushStrength * pushMagnitude;
    }
    return 0;
  });
  const pushAngle = useTransform(() => {
    if (centerX === 0 || centerY === 0) {
      return angle;
    }
    const { x: px, y: py } = pointerPosition.get();
    const dotX = centerX + baseX;
    const dotY = centerY + baseY;
    return Math.atan2(dotY - py, dotX - px);
  });
  const pushX = useTransform(() => {
    const distance = pushDistance.get();
    return Math.cos(pushAngle.get()) * distance;
  });
  const pushY = useTransform(() => {
    const distance = pushDistance.get();
    return Math.sin(pushAngle.get()) * distance;
  });
  const springPushX = useSpring(pushX, pushSpring);
  const springPushY = useSpring(pushY, pushSpring);
  const x = useTransform(() => baseX + springPushX.get());
  const y = useTransform(() => baseY + springPushY.get());
  const dotVariants = {
    default: { scale: 1 },
    hover: {
      scale: 1.5,
      transition: { duration: reduceMotion ? 0 : 0.13 },
    },
  };
  const ringVariants = {
    default: { opacity: 0 },
    hover: {
      opacity: 0.4,
      transition: { duration: reduceMotion ? 0 : 0.13 },
    },
  };

  return (
    <motion.button
      aria-label={option.label}
      className={styles.colorDot}
      initial="default"
      onClick={onSelect}
      style={{
        x,
        y,
        backgroundColor: theme === "dark" ? option.darkSwatch : option.lightSwatch,
        willChange: "transform, background-color",
      }}
      transition={{
        scale: {
          type: "spring",
          damping: 30,
          stiffness: 200,
          duration: reduceMotion ? 0 : undefined,
        },
      }}
      type="button"
      variants={dotVariants}
      whileHover="hover"
      whileTap={{ scale: reduceMotion ? 1 : 1.2 }}
    >
      <motion.span className={styles.colorDotRing} variants={ringVariants} />
    </motion.button>
  );
}

function GradientCircle({
  index,
  totalInRing,
  centerX,
  centerY,
  pointerPosition,
  containerRadius,
  color,
  reduceMotion,
}: {
  index: number;
  totalInRing: number;
  centerX: number;
  centerY: number;
  pointerPosition: MotionValue<PointerCoordinates>;
  containerRadius: number;
  color: string;
  reduceMotion: boolean;
}) {
  const angle = calculateAngle(index, totalInRing);
  const baseRadius = containerRadius - 40;
  const { x: baseX, y: baseY } = calculateBasePosition(angle, baseRadius);
  const gradient = `radial-gradient(circle, ${color} 0%, ${color}00 66%)`;
  const proximity = useTransform(() => {
    if (centerX === 0 || centerY === 0) {
      return 0;
    }
    const { x: px, y: py } = pointerPosition.get();
    const gradientX = centerX + baseX;
    const gradientY = centerY + baseY;
    const dx = px - gradientX;
    const dy = py - gradientY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return Math.max(0, 1 - distance / 100);
  });
  const opacity = useTransform(proximity, [0, 1], [0.15, 0.35]);
  const scale = useTransform(proximity, [0, 1], [1, 1.2]);
  const springOpacity = useSpring(opacity, {
    damping: 30,
    stiffness: 100,
  });
  const springScale = useSpring(scale, {
    damping: 30,
    stiffness: 100,
  });

  return (
    <motion.span
      aria-hidden="true"
      className={styles.gradientCircle}
      style={{
        x: baseX,
        y: baseY,
        opacity: reduceMotion ? 0.15 : springOpacity,
        scale: reduceMotion ? 1 : springScale,
        background: gradient,
        willChange: "transform, opacity",
      }}
    />
  );
}

function usePointerPosition(): MotionValue<PointerCoordinates> {
  const position = useMotionValue<PointerCoordinates>({ x: 0, y: 0 });
  const latestPosition = useRef<PointerCoordinates>({ x: 0, y: 0 });
  const animationFrame = useRef<number | null>(null);

  useEffect(() => {
    const update = (event: PointerEvent) => {
      latestPosition.current.x = event.clientX;
      latestPosition.current.y = event.clientY;
      if (animationFrame.current !== null) {
        return;
      }
      animationFrame.current = window.requestAnimationFrame(() => {
        animationFrame.current = null;
        position.set({
          x: latestPosition.current.x,
          y: latestPosition.current.y,
        });
      });
    };
    window.addEventListener("pointermove", update, { passive: true });
    return () => {
      window.removeEventListener("pointermove", update);
      if (animationFrame.current !== null) {
        window.cancelAnimationFrame(animationFrame.current);
        animationFrame.current = null;
      }
    };
  }, [position]);

  return position;
}

function calculateAngle(index: number, totalInRing: number): number {
  return (index / totalInRing) * Math.PI * 2;
}

function calculateBasePosition(angle: number, radius: number) {
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
}
