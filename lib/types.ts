export type SessionStatus = 'waiting' | 'running' | 'paused' | 'ended';
export type LastEventType = 'none' | 'unlock' | 'vault' | 'status';
export type RequestType = 'hint' | 'emergency';
export type RequestStatus = 'pending' | 'approved' | 'rejected';

export interface SessionDoc {
  id: string;
  sessionCode: string;
  title: string;
  status: SessionStatus;
  durationSeconds: number;
  remainingSecondsAtPause: number;
  startedAtMs: number;
  endedAtMs: number;
  pointsCorrect: number;
  pointsFastest: number;
  pointsFinalFirst: number;
  pointsWrong: number;
  pointsHint: number;
  pointsEmergency: number;
  totalSheets: number;
  maxGroups?: number;
  lastEventId: string;
  lastEventType: LastEventType;
  lastEventTeam: string;
  lastEventMessage: string;
  lastEventAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface GroupDoc {
  id: string;
  teamName: string;
  members: string[];
  points: number;
  currentSheet: number;
  completedSheets: number;
  finishedAtMs: number;
  lastActivityText: string;
  lastActivityAtMs: number;
  cooldownUntilMs: number;
  lastSubmitAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface HelpRequestDoc {
  id: string;
  groupId: string;
  teamName: string;
  type: RequestType;
  sheetNumber: number;
  status: RequestStatus;
  createdAtMs: number;
  resolvedAtMs: number;
}

export interface PointLogDoc {
  id: string;
  groupId: string;
  teamName: string;
  action: string;
  reason: string;
  delta: number;
  balanceAfter: number;
  sheetNumber: number;
  createdAtMs: number;
}

export interface SheetConfigItem {
  sheetNumber: number;
  sheetCode: string;
  normalizedKey: string;
  hintText: string;
}

export interface UnlockedHintItem {
  sheetNumber: number;
  hintText: string;
  unlockedAtMs: number;
}

export interface UnlockedEmergencyItem {
  sheetNumber: number;
  keyValue: string;
  unlockedAtMs: number;
}

export interface GroupPrivateStateResponse {
  groupId: string;
  groupCode: string;
  teamName: string;
  members: string[];
  points: number;
  currentSheet: number;
  completedSheets: number;
  totalSheets: number;
  currentSheetCode: string | null;
  unlockedHints: UnlockedHintItem[];
  unlockedEmergencyKeys: UnlockedEmergencyItem[];
  cooldownUntilMs: number;
  serverNowMs: number;
}

export interface AdminGroupSummary extends GroupDoc {
  groupCode: string;
}

export interface AdminSessionPayload {
  session: SessionDoc;
  sheets: SheetConfigItem[];
  groups: AdminGroupSummary[];
  requests: HelpRequestDoc[];
  logs: PointLogDoc[];
  serverNowMs: number;
}
