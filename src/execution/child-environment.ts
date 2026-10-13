/**
 * The environment given to commands Conclave runs from an execution plan.
 *
 * The CLI loads provider credentials into `process.env` at startup (the project `.env` and the
 * per-user `credentials.env`), next to whatever the user's shell exports. A child that inherits
 * that environment can read every one of those values. Plan commands therefore start from an
 * empty environment and receive only the variables named here, plus any the operator forwards
 * by name.
 *
 * This bounds what a command can read from its environment. It is not a sandbox: the command
 * still runs as the user, with the user's files, network and processes, and can read a
 * credential file directly.
 */

/** Variables a local test, build or lint command needs to start at all. None holds a secret. */
export const CHILD_ENVIRONMENT_ALLOWLIST: readonly string[] = [
  // Locating executables and per-user tool state such as package caches.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  // Locale, time zone and terminal behaviour.
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  // Toolchains located through a variable rather than PATH.
  "JAVA_HOME",
  "VIRTUAL_ENV",
  // Windows cannot start most programs without these.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
];

// Bounded so the names always fit in a receipt summary.
const MAX_FORWARDED_VARIABLES = 10;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
// Conclave's own secrets are for Conclave. No plan command has a reason to hold them.
const CONCLAVE_CREDENTIAL = /^CONCLAVE_.*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu;

export interface ChildEnvironmentOptions {
  readonly parent?: NodeJS.ProcessEnv;
  /** Extra variable names the operator chose to pass through for this run. */
  readonly forward?: readonly string[];
  readonly platform?: NodeJS.Platform;
}

/** Validates operator-supplied names. Values are never accepted here, only names. */
export function parseForwardedVariables(names: readonly string[]): readonly string[] {
  if (new Set(names).size > MAX_FORWARDED_VARIABLES) {
    throw new Error(`At most ${String(MAX_FORWARDED_VARIABLES)} environment variables can be forwarded`);
  }
  for (const name of names) {
    if (!VARIABLE_NAME.test(name)) throw new Error(`Invalid environment variable name to forward: ${JSON.stringify(name)}`);
    if (CONCLAVE_CREDENTIAL.test(name)) throw new Error(`Refusing to forward a Conclave credential to an executed command: ${name}`);
  }
  return [...new Set(names)];
}

export function createChildEnvironment(options: ChildEnvironmentOptions = {}): NodeJS.ProcessEnv {
  const parent = options.parent ?? process.env;
  // Windows variable names are case-insensitive (`Path`, `SystemRoot`); elsewhere `path` and
  // `PATH` are different variables and only the exact name is allowed.
  const normalize = (options.platform ?? process.platform) === "win32"
    ? (name: string): string => name.toUpperCase()
    : (name: string): string => name;
  const allowed = new Set([...CHILD_ENVIRONMENT_ALLOWLIST, ...parseForwardedVariables(options.forward ?? [])].map(normalize));
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && allowed.has(normalize(name))) environment[name] = value;
  }
  return environment;
}
