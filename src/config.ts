export interface UserCredentialMapping {
    togglApiToken: string;
    togglWorkspaceId: number;
    togglUserId: number;
    togglClientIds?: number[];
    redmineUsername: string;
    redmineUserId: number;
    notificationsEmail: string;
}

export interface Config {
    redmineApiToken: string;
    redmineBaseUrl: string;
    lastMonthSyncExpiryDays: number;
    updateEntriesAsAdminUser: boolean;
    adminNotificationsEmail: string;
    smtpServer: string;
    smtpPassword: string;
    smtpUsername: string;
    smtpSender: string; // e.g. '"toggl-redmine sync" <redmine@somedomain.com>'
    userCredentialMappings: UserCredentialMapping[];
    tagToActivityMappings: Record<string, number>;
}