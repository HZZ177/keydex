import {
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
  useRef,
} from "react";

import revealStyles from "./A2UIReveal.module.css";

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

const MOTION_KEY_ATTRIBUTE = "data-a2ui-motion-key";

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
