/**
 * Claude Agent Driver browser plugin, node half. Host behavior stays in the
 * provider package; this empty entry lets the Loader materialize the optional
 * client registration from the package manifest.
 */

/** Host plugin body — browser registration ships through `exports["./client"]`. */
export function apply(): void {}
