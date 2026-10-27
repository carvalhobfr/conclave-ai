import type { PluginCommand, PluginParameter } from "../../src/workflow/plugin-manifest.js";

export type HostValue = string | number | boolean | readonly string[];

/**
 * The reference implementation of the manifest's argv rule: the command's leading `argv`, then
 * positional parameters in declared order, then each provided flagged parameter.
 */
export function buildArgv(command: PluginCommand, values: Readonly<Record<string, HostValue>>): string[] {
  const argv = [...command.argv];
  const provided = (parameter: PluginParameter): HostValue | undefined => values[parameter.name];
  for (const parameter of command.parameters) {
    const value = provided(parameter);
    if (parameter.required && value === undefined) throw new Error(`Missing required parameter: ${parameter.name}`);
    if (parameter.flag !== undefined || value === undefined) continue;
    argv.push(...(typeof value === "object" ? value : [String(value)]));
  }
  for (const parameter of command.parameters) {
    const value = provided(parameter);
    if (parameter.flag === undefined || value === undefined) continue;
    if (parameter.type === "switch") {
      if (value === true) argv.push(parameter.flag);
      continue;
    }
    argv.push(parameter.flag, String(value));
  }
  return argv;
}

/** Follows a manifest field path such as `summary.dirty` or `commits[].shortSha`. */
export function readPath(value: unknown, path: string): unknown[] {
  let current: unknown[] = [value];
  for (const segment of path.split(".")) {
    const each = segment.endsWith("[]");
    const key = each ? segment.slice(0, -2) : segment;
    current = current.flatMap((item) => {
      if (typeof item !== "object" || item === null || !(key in item)) return [];
      const next = (item as Record<string, unknown>)[key];
      return each ? (Array.isArray(next) ? next as unknown[] : []) : [next];
    });
  }
  return current;
}
