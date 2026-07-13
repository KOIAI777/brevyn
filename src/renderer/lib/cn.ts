import clsx from "clsx";

export function cx(...values: Array<string | false | null | undefined>) {
  return clsx(values);
}
