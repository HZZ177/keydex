import {
  type ComponentProps,
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useRef,
} from "react";
import {
  AnimatePresence,
  LayoutGroup,
  MotionConfig,
  motion,
} from "motion/react";

import revealStyles from "./A2UIReveal.module.css";
import { useExpansionScrollAnchor } from "../useExpansionScrollAnchor";

interface A2UIMotionRootProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  children?: ReactNode;
}

interface A2UIMotionItemProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  children?: ReactNode;
  motionKey: string;
  motionKind?: string;
}

type InteractiveMotionState =
  | "active"
  | "dirty"
  | "submitting"
  | "submitted"
  | "cancelled"
  | "readonly"
  | "error";

type InteractiveMotionVariant =
  | "scene"
  | "intro"
  | "option"
  | "field"
  | "compact"
  | "dock"
  | "result"
  | "floating"
  | "tray"
  | "receipt";

export type A2InteractiveMotionTransition = ComponentProps<typeof motion.div>["transition"];

interface A2InteractiveMotionRootProps extends ComponentProps<typeof motion.section> {
  children?: ReactNode;
  live?: boolean;
  motionScope: string;
  motionState?: InteractiveMotionState;
}

interface A2InteractiveMotionItemProps extends HTMLAttributes<HTMLElement> {
  as?: "div" | "label" | "p" | "span";
  children?: ReactNode;
  interactive?: boolean;
  live?: boolean;
  motionLayout?: ComponentProps<typeof motion.div>["layout"];
  motionTransition?: A2InteractiveMotionTransition;
  motionKey: string;
  motionKind?: string;
  order?: number;
  selected?: boolean;
  variant?: InteractiveMotionVariant;
}

const MOTION_KEY_ATTRIBUTE = "data-a2ui-motion-key";
const A2UI_INTERACTIVE_SCROLL_LOCK_MS = 720;
const A2UI_MOTION_EASE = [0.22, 1, 0.36, 1] as const;
const A2UI_MOTION_EASE_SHARP = [0.16, 1, 0.3, 1] as const;

const sceneVariants = {
  hidden: {
    opacity: 0,
    y: 18,
    scale: 0.982,
    filter: "blur(4px)",
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: {
      duration: 0.72,
      ease: A2UI_MOTION_EASE,
      staggerChildren: 0.085,
      delayChildren: 0.08,
    },
  },
};

const itemVariants = {
  hidden: (order = 0) => ({
    opacity: 0,
    y: order > 0 ? 8 : 5,
    scale: 0.985,
    filter: "blur(1px)",
  }),
  visible: (order = 0) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: {
      duration: 0.3,
      ease: A2UI_MOTION_EASE,
      delay: Math.min(order * 0.035, 0.24),
    },
  }),
  exit: {
    opacity: 0,
    y: -4,
    scale: 0.992,
    filter: "blur(1px)",
    transition: {
      duration: 0.18,
      ease: A2UI_MOTION_EASE_SHARP,
    },
  },
};

const introVariants = {
  hidden: {
    opacity: 0,
    x: -18,
    y: 8,
    filter: "blur(3px)",
  },
  visible: {
    opacity: 1,
    x: 0,
    y: 0,
    filter: "blur(0px)",
    transition: {
      duration: 0.58,
      ease: A2UI_MOTION_EASE,
    },
  },
  exit: itemVariants.exit,
};

const optionVariants = {
  hidden: (order = 0) => ({
    opacity: 0,
    x: order % 2 ? 28 : -28,
    y: 22 + Math.min(order * 4, 24),
    rotate: order % 2 ? 1.4 : -1.2,
    scale: 0.955,
    filter: "blur(5px)",
  }),
  visible: (order = 0) => ({
    opacity: 1,
    x: 0,
    y: 0,
    rotate: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: {
      duration: 0.62,
      ease: A2UI_MOTION_EASE,
      delay: Math.min(order * 0.065, 0.42),
    },
  }),
  exit: {
    opacity: 0,
    x: -18,
    y: -8,
    rotate: -0.8,
    scale: 0.98,
    filter: "blur(3px)",
    transition: {
      duration: 0.24,
      ease: A2UI_MOTION_EASE_SHARP,
    },
  },
};

const fieldVariants = {
  hidden: (order = 0) => ({
    opacity: 0,
    x: order % 2 ? 24 : -24,
    y: 30,
    scale: 0.965,
    filter: "blur(5px)",
  }),
  visible: (order = 0) => ({
    opacity: 1,
    x: 0,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: {
      duration: 0.68,
      ease: A2UI_MOTION_EASE,
      delay: Math.min(order * 0.055, 0.38),
    },
  }),
  exit: {
    opacity: 0,
    x: 18,
    y: -8,
    scale: 0.982,
    filter: "blur(3px)",
    transition: {
      duration: 0.22,
      ease: A2UI_MOTION_EASE_SHARP,
    },
  },
};

const resultVariants = {
  hidden: {
    opacity: 0,
    y: 22,
    scale: 0.972,
    filter: "blur(5px)",
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: {
      duration: 0.66,
      ease: A2UI_MOTION_EASE,
      staggerChildren: 0.055,
    },
  },
  exit: itemVariants.exit,
};

const dockVariants = {
  hidden: {
    opacity: 0,
    y: 6,
    scale: 0.99,
  },
  visible: (order = 0) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.26,
      ease: A2UI_MOTION_EASE,
      delay: Math.min(order * 0.03, 0.18),
    },
  }),
  exit: {
    opacity: 0,
    y: 4,
    scale: 0.99,
    transition: {
      duration: 0.16,
      ease: A2UI_MOTION_EASE_SHARP,
    },
  },
};

const floatingVariants = {
  hidden: {
    opacity: 0,
    y: -5,
    scale: 0.985,
    transformOrigin: "50% 0%",
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.18,
      ease: A2UI_MOTION_EASE,
      staggerChildren: 0.025,
      delayChildren: 0.03,
    },
  },
  exit: {
    opacity: 0,
    y: -4,
    scale: 0.985,
    transition: {
      duration: 0.13,
      ease: A2UI_MOTION_EASE_SHARP,
    },
  },
};

const floatingItemVariants = {
  hidden: {
    opacity: 0,
    x: -3,
  },
  visible: {
    opacity: 1,
    x: 0,
    transition: {
      duration: 0.16,
      ease: A2UI_MOTION_EASE,
    },
  },
};

export function A2UIMotionRoot({
  as: Component = "div",
  children,
  className,
  ...props
}: A2UIMotionRootProps) {
  const Root = Component as ElementType;

  return (
    <Root
      {...props}
      className={joinClassNames(revealStyles.motionRoot, className)}
      data-a2ui-motion-root="true"
    >
      {children}
    </Root>
  );
}

export function A2InteractiveMotionRoot({
  children,
  className,
  live = false,
  motionScope,
  motionState = "active",
  onKeyDownCapture,
  onPointerDownCapture,
  ...props
}: A2InteractiveMotionRootProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const captureExpansionAnchor = useExpansionScrollAnchor(A2UI_INTERACTIVE_SCROLL_LOCK_MS);
  const captureInteractiveScrollAnchor = useCallback(() => {
    captureExpansionAnchor(rootRef.current);
  }, [captureExpansionAnchor]);
  const handlePointerDownCapture: NonNullable<ComponentProps<typeof motion.section>["onPointerDownCapture"]> = (event) => {
    captureInteractiveScrollAnchor();
    onPointerDownCapture?.(event);
  };
  const handleKeyDownCapture: NonNullable<ComponentProps<typeof motion.section>["onKeyDownCapture"]> = (event) => {
    if ((event.key === "Enter" || event.key === " ") && !isEditableEventTarget(event.target)) {
      captureInteractiveScrollAnchor();
    }
    onKeyDownCapture?.(event);
  };

  return (
    <MotionConfig
      reducedMotion="user"
      transition={{
        duration: 0.24,
        ease: A2UI_MOTION_EASE,
      }}
    >
      <LayoutGroup id={motionScope}>
        <motion.section
          {...props}
          ref={rootRef}
          className={joinClassNames(revealStyles.motionRoot, className)}
          data-a2ui-interactive-motion="true"
          data-a2ui-motion-live={live ? "true" : "false"}
          data-a2ui-motion-root="true"
          data-a2ui-motion-state={motionState}
          initial={live ? "hidden" : false}
          animate="visible"
          variants={sceneVariants}
          layout="position"
          onKeyDownCapture={handleKeyDownCapture}
          onPointerDownCapture={handlePointerDownCapture}
        >
          {children}
        </motion.section>
      </LayoutGroup>
    </MotionConfig>
  );
}

export function A2UIMotionItem({
  as: Component = "div",
  children,
  className,
  motionKey,
  motionKind,
  ...props
}: A2UIMotionItemProps) {
  const Item = Component as ElementType;

  return (
    <Item
      {...props}
      {...a2uiMotionItemProps(motionKey, motionKind)}
      className={joinClassNames(revealStyles.motionItem, className)}
    >
      {children}
    </Item>
  );
}

export function A2InteractiveMotionItem({
  as = "div",
  children,
  className,
  interactive = false,
  live = false,
  motionLayout = "position",
  motionTransition,
  motionKey,
  motionKind,
  order = 0,
  selected = false,
  variant = "compact",
  ...props
}: A2InteractiveMotionItemProps) {
  const sharedProps = {
    ...props,
    ...a2uiMotionItemProps(motionKey, motionKind),
    className: joinClassNames(revealStyles.motionItem, className),
    "data-a2ui-interactive-item": "true",
    "data-a2ui-motion-variant": variant,
    custom: order,
    initial: live ? "hidden" : false,
    animate: "visible",
    exit: "exit",
    variants: variantsFor(variant),
    layout: motionLayout,
    transition: motionTransition,
    whileHover: interactive ? hoverMotionFor(variant, selected) : undefined,
  };

  if (as === "label") {
    return (
      <motion.label {...(sharedProps as ComponentProps<typeof motion.label>)}>
        {children}
      </motion.label>
    );
  }
  if (as === "p") {
    return (
      <motion.p {...(sharedProps as ComponentProps<typeof motion.p>)}>
        {children}
      </motion.p>
    );
  }
  if (as === "span") {
    return (
      <motion.span {...(sharedProps as ComponentProps<typeof motion.span>)}>
        {children}
      </motion.span>
    );
  }
  return (
    <motion.div {...(sharedProps as ComponentProps<typeof motion.div>)}>
      {children}
    </motion.div>
  );
}

export function A2MotionPresence({
  children,
  preserveExit = false,
}: {
  children?: ReactNode;
  preserveExit?: boolean;
}) {
  if (!preserveExit) {
    return <>{children}</>;
  }
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {children}
    </AnimatePresence>
  );
}

export function A2FloatingMotionPanel({
  children,
  className,
  ...props
}: ComponentProps<typeof motion.div>) {
  return (
    <motion.div
      {...props}
      className={className}
      data-a2ui-floating-motion="true"
      initial="hidden"
      animate="visible"
      exit="exit"
      variants={floatingVariants}
    >
      {children}
    </motion.div>
  );
}

export function A2FloatingMotionItem({
  children,
  className,
  ...props
}: ComponentProps<typeof motion.button>) {
  return (
    <motion.button
      {...props}
      className={className}
      data-a2ui-floating-motion-item="true"
      variants={floatingItemVariants}
      whileHover={{ x: 1 }}
      whileTap={{ scale: 0.985 }}
    >
      {children}
    </motion.button>
  );
}

export function A2ActionMotionButton({
  children,
  className,
  disabled,
  ...props
}: ComponentProps<typeof motion.button>) {
  const active = disabled !== true;
  return (
    <motion.button
      {...props}
      className={className}
      data-a2ui-action-motion="true"
      disabled={disabled}
      transition={{
        type: "spring",
        stiffness: 420,
        damping: 34,
        mass: 0.7,
      }}
      whileFocus={active ? {
        scale: 1.014,
        transition: {
          type: "spring",
          stiffness: 420,
          damping: 34,
          mass: 0.7,
        },
      } : undefined}
      whileHover={active ? {
        scale: 1.018,
        transition: {
          type: "spring",
          stiffness: 440,
          damping: 32,
          mass: 0.66,
        },
      } : undefined}
      whileTap={active ? {
        scale: 0.98,
        transition: {
          type: "spring",
          stiffness: 520,
          damping: 30,
          mass: 0.64,
        },
      } : undefined}
    >
      {children}
    </motion.button>
  );
}

export function a2uiMotionItemProps(
  motionKey: string,
  motionKind?: string,
): Record<string, string> {
  return {
    [MOTION_KEY_ATTRIBUTE]: motionKey,
    ...(motionKind ? { "data-a2ui-motion-kind": motionKind } : {}),
  };
}

export function useA2UILayoutMotion() {
  return useRef<HTMLElement | null>(null);
}

function joinClassNames(...classNames: Array<string | undefined>): string {
  return classNames.filter(Boolean).join(" ");
}

function hoverMotionFor(variant: InteractiveMotionVariant, selected: boolean) {
  if (variant === "option") {
    return undefined;
  }
  if (variant === "field") {
    return {
      y: -2,
      transition: { duration: 0.24, ease: A2UI_MOTION_EASE },
    };
  }
  return {
    y: -0.5,
    transition: { duration: 0.14, ease: A2UI_MOTION_EASE },
  };
}

function variantsFor(variant: InteractiveMotionVariant) {
  if (variant === "dock" || variant === "tray") {
    return dockVariants;
  }
  if (variant === "intro") {
    return introVariants;
  }
  if (variant === "option") {
    return optionVariants;
  }
  if (variant === "field") {
    return fieldVariants;
  }
  if (variant === "result" || variant === "receipt") {
    return resultVariants;
  }
  return itemVariants;
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}
