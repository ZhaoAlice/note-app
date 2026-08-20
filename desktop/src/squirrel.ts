const lifecycleEvents = new Set([
  '--squirrel-install',
  '--squirrel-updated',
  '--squirrel-uninstall',
  '--squirrel-obsolete',
])

export function squirrelLifecycleEvent(argv: readonly string[]): string | null {
  const event = argv[1]
  return event && lifecycleEvents.has(event) ? event : null
}
