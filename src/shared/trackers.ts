// Tools Flux reads your work from: tickets, or comments on designs
export type TrackerName = 'jira' | 'linear' | 'figma' | 'trello' | 'notion'

export interface TrackerInfo {
  id: TrackerName
  label: string
  // Files its tickets into projects, each of which can become a workspace
  projects?: boolean
  // Not wired to a source yet: listed so the choice is visible, but cannot be added
  soon?: boolean
}

export const TRACKERS: TrackerInfo[] = [
  { id: 'jira', label: 'Jira', projects: true },
  { id: 'linear', label: 'Linear', projects: true },
  { id: 'figma', label: 'Figma' },
  { id: 'trello', label: 'Trello', soon: true },
  { id: 'notion', label: 'Notion', soon: true },
]

export const AVAILABLE_TRACKERS = TRACKERS.filter(tracker => !tracker.soon).map(tracker => tracker.id)

export function isTracker(name: string): name is TrackerName {
  return TRACKERS.some(tracker => tracker.id === name)
}

// The chosen tools whose projects can become workspaces
export function projectTrackers(trackers: TrackerName[]): TrackerName[] {
  return trackers.filter(name => TRACKERS.find(tracker => tracker.id === name)?.projects)
}
