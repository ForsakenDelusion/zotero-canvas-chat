export const hostColors = {
  "--ink": "--fill-primary",
  "--muted": "--fill-secondary",
  "--line": "--stroke-secondary",
  "--panel": "--material-sidepane",
  "--hover": "--fill-quinary",
  "--accent": "--color-accent",
} as const;

export type CanvasTheme = {
  dark: boolean;
  colors: Partial<Record<keyof typeof hostColors, string>>;
};
