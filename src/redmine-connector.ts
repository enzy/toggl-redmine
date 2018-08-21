import {Helper} from "./helper";
import {Vector} from "prelude.ts";
import moment = require("moment");
import logger from "./logger";
let Redmine = require('node-redmine');

export module RedmineConnector {

    export interface SyncParameters {
        apiToken: string;
        baseUrl: string;
        from: string; //YYYY-MM-DD format
        to: string; //YYYY-MM-DD format
        togglUserId: number;
        redmineUsername: string;
    }
    
    // Redmine API docs: 
    // offset: the offset of the first object to retrieve
    // limit: the number of items to be present in the response (default is 25, maximum is 100)
    const queryPageLimit = 100;
    
    export interface SyncSuccess {
        togglEntry: TogglApi.TimeEntry;
        existingEntry: RedmineApi.TimeEntry | null;
        newEntry: RedmineApi.ParamsCreateOrUpdateTimeEntry;
        action: 'create' | 'update' | 'nop';
    }

    export interface SyncError {
        togglUserId: number;
        entry: TogglApi.TimeEntry | RedmineApi.TimeEntry;
        errorMessage: string;
    }

    export function isSyncError(item: SyncSuccess | SyncError): item is SyncError{
        return (<SyncError>item).errorMessage !== undefined;
    }
    
    function matchesBySuffixKey(redmineTimeEntry: RedmineApi.TimeEntry, togglEntry: TogglApi.TimeEntry) {
        return redmineTimeEntry.comments.endsWith(`[${togglEntry.id}]`)
    }
    
    function getRedmineTimeEntryDescriptionWithKey(togglEntry: TogglApi.TimeEntry) {
        return togglEntry.description + ` [${togglEntry.id}]`
    }
    
    function getRedmineUserById(redmineUsers: Vector<RedmineApi.User>, id: number) {
        return redmineUsers.filter(x => x.id === id).single().getOrThrow();
    }
    
    export async function syncTogglEnties(syncParams: SyncParameters, togglEntries: Vector<TogglApi.TimeEntry>): Promise<Vector<SyncSuccess | SyncError>> {
        const referencedIssueIds = togglEntries
            .mapOption(x => Helper.extractSingleHashtagNumber(x.description))
            .distinctBy(x => x);

        logger.info(`Querying Redmine users`);
        // call with non-impersonating client
        const redmineUsers = await queryRedmineUsers(<RedmineApi.Client>new Redmine(syncParams.baseUrl, { apiKey: syncParams.apiToken}));
        logger.info(`Acquired ${redmineUsers.length()} Redmine users: "${redmineUsers.map(x => x.login).mkString(', ')}"`);

        // logger.info(`Impersonating user ${syncParams.redmineUsername}`);
        // redmineApiClient.impersonate = syncParams.redmineUsername;

        logger.info(`Creating Redmine client, impersonating user ${syncParams.redmineUsername}`);
        const redmineApiClient = <RedmineApi.Client>new Redmine(syncParams.baseUrl, { apiKey: syncParams.apiToken, impersonate: syncParams.redmineUsername});
        
        logger.info(`Querying ${referencedIssueIds.length()} Redmine issues: "${referencedIssueIds.mkString(', ')}"`);
        const redmineIssues = await queryRedmineIssues(redmineApiClient, referencedIssueIds);
        logger.info(`Acquired ${redmineIssues.length()} Redmine issues: "${redmineIssues.map(x => x.id).mkString(', ')}"`);

        logger.info(`Querying Redmine time entries`);
        const redmineTimeEntries = await queryRedmineTimeEntries(redmineApiClient);
        logger.info(`Acquired ${redmineTimeEntries.length()} Redmine time entries`);

        return Vector.ofIterable(
            //process all Toggl entries (check/sync to redmine)
            await Promise.all(
                togglEntries.map(async togglEntry => await syncTogglEntry(
                    redmineApiClient, 
                    syncParams, 
                    togglEntry, 
                    redmineIssues, 
                    redmineTimeEntries.filter(redmineEntry => getRedmineUserById(redmineUsers, redmineEntry.user.id).login === syncParams.redmineUsername)))
            )
        ).appendAll(
            //process all Redmine entries (detech possibly deleted entries)
            redmineTimeEntries
                .filter(redmineEntry => redmineEntry.comments.match(/\[[0-9]+\]/g) !== null) // filter by those ending with '[number]'
                .filter(redmineEntry => getRedmineUserById(redmineUsers, redmineEntry.user.id).login === syncParams.redmineUsername) // filter by current user
                .filter(redmineEntry => ! togglEntries.anyMatch(togglEntry => matchesBySuffixKey(redmineEntry, togglEntry))) // filter by missing a corresponding toggl entry
                .map(redmineEntry => { return {
                    togglUserId: syncParams.togglUserId,
                    entry: redmineEntry, 
                    errorMessage: "No corresponding Toggl entry for Redmine entry (Deleted toggl entry after it was synced to redmine? If yes, go and delete it manually in redmine as well.)"} })
        ).sortBy((x, y) => {
            const ts1 = isSyncError(x) ? (Helper.isTogglEntry(x.entry) ? moment(x.entry.start).valueOf() : moment(x.entry.spent_on).valueOf()) : moment(x.togglEntry.start).valueOf();
            const ts2 = isSyncError(y) ? (Helper.isTogglEntry(y.entry) ? moment(y.entry.start).valueOf() : moment(y.entry.spent_on).valueOf()) : moment(y.togglEntry.start).valueOf();
            return ts2 - ts1;
        });
    }

    async function syncTogglEntry(
        redmineApiClient: RedmineApi.Client,
        syncParams: SyncParameters,
        togglEntry: TogglApi.TimeEntry,
        redmineIssues: Vector<RedmineApi.Issue>,
        redmineTimeEntries: Vector<RedmineApi.TimeEntry>
    ): Promise<SyncSuccess | SyncError> {
        try {
            const issueId = Helper
                .extractSingleHashtagNumber(togglEntry.description).getOrThrow("Missing issue hashtag");

            const matchingRedmineIssue = redmineIssues
                .filter(x => x.id === issueId)
                .single()
                .getOrThrow(`No matching Redmine issue #${issueId} found`);

            const spentOn = moment(togglEntry.start).format('YYYY-MM-DD');
            const hours = Number(
                moment(togglEntry.end)
                    .diff(moment(togglEntry.start), 'hours', true)
                    .toPrecision(2)
            );

            const existingMatchingEntries = redmineTimeEntries.filter(x => matchesBySuffixKey(x, togglEntry));

            const paramsCreateOrUpdateTimeEntry: RedmineApi.ParamsCreateOrUpdateTimeEntry = {
                issue_id: matchingRedmineIssue.id,
                project_id: matchingRedmineIssue.project.id,
                hours: hours,
                // activity_id:
                comments: getRedmineTimeEntryDescriptionWithKey(togglEntry),
                spent_on: spentOn
            };
                
            if(existingMatchingEntries.isEmpty()) {
                await createRedmineTimeEntry(redmineApiClient, paramsCreateOrUpdateTimeEntry);

                return {
                    togglEntry: togglEntry,
                    existingEntry: null,
                    newEntry: paramsCreateOrUpdateTimeEntry,
                    action: "create"
                }
            }
            else {
                const existingEntry = existingMatchingEntries
                    .single()
                    .getOrThrow(`Multiple matches found for toggl entry ${togglEntry.id}, user ${syncParams.redmineUsername}`);

                if (existingEntry.issue.id !== paramsCreateOrUpdateTimeEntry.issue_id ||
                    existingEntry.project.id !== paramsCreateOrUpdateTimeEntry.project_id ||
                    existingEntry.hours !== paramsCreateOrUpdateTimeEntry.hours ||
                    existingEntry.comments !== paramsCreateOrUpdateTimeEntry.comments ||
                    existingEntry.spent_on !== paramsCreateOrUpdateTimeEntry.spent_on) {
                    await updateRedmineTimeEntry(redmineApiClient, existingEntry.id, paramsCreateOrUpdateTimeEntry);

                    return {
                        togglEntry: togglEntry,
                        existingEntry: existingEntry,
                        newEntry: paramsCreateOrUpdateTimeEntry,
                        action: "update"
                    }
                }

                return {
                    togglEntry: togglEntry,
                    existingEntry: existingEntry,
                    newEntry: paramsCreateOrUpdateTimeEntry,
                    action: "nop"
                }
            }
            
            throw new Error("Broken sync code, this line should be unreachable.")
        }
        catch (error) {
            return {
                togglUserId: syncParams.togglUserId,
                entry: togglEntry,
                errorMessage: error
            };
        }
    }

    async function queryRedmineUsers(redmineApiClient: RedmineApi.Client, page = 1) {
        return new Promise<Vector<RedmineApi.User>>((resolve, reject) => {
            redmineApiClient.users({limit: queryPageLimit},
                async (err: any, data: RedmineApi.Users) => {
                    if (err !== null) {
                        const errorMsg = "Failed to retrieve redmine users: " + JSON.stringify(err);
                        logger.error(errorMsg);
                        return reject(new Error(errorMsg));
                    }
                    let usersTail = Vector.ofIterable(data.users);

                    if (page * data.limit < data.total_count) {
                        const usersNextPage = await queryRedmineUsers(redmineApiClient, page + 1);
                        usersTail = usersTail.appendAll(usersNextPage);
                    }

                    resolve(usersTail);
                });
        })
    }

    async function queryRedmineIssues(redmineApiClient: RedmineApi.Client, issueIds: Vector<number>, page = 1) {
        return new Promise<Vector<RedmineApi.Issue>>((resolve, reject) => {
            let commaSeparatedIssueIds = issueIds.mkString(',');
            redmineApiClient.issues({limit: queryPageLimit, issue_id: commaSeparatedIssueIds},
                async (err: any, data: RedmineApi.Issues) => {
                    if (err !== null) {
                        const errorMsg = "Failed to retrieve redmine issues: " + JSON.stringify(err);
                        logger.error(errorMsg);
                        return reject(new Error(errorMsg));
                    }
                    let issuesTail = Vector.ofIterable(data.issues);

                    if (page * data.limit < data.total_count) {
                        const issuesNextPage = await queryRedmineIssues(redmineApiClient, issueIds, page + 1);
                        issuesTail = issuesTail.appendAll(issuesNextPage);
                    }
                    
                    resolve(issuesTail);
                });
        })
    }

    async function queryRedmineTimeEntries(redmineApiClient: RedmineApi.Client, page = 1) {
        return new Promise<Vector<RedmineApi.TimeEntry>>((resolve, reject) => {
            redmineApiClient.time_entries({limit: queryPageLimit, offset: (page - 1) * queryPageLimit},
                async (err: any, data: RedmineApi.TimeEntries) => {
                    if (err !== null) {
                        const errorMsg = "Failed to retrieve redmine time entries: " + JSON.stringify(err);
                        logger.error(errorMsg);
                        return reject(new Error(errorMsg));
                    }
                    let timeEntriesTail = Vector.ofIterable(data.time_entries);

                    if (page * data.limit < data.total_count) {
                        const timeEntriesNextPage = await queryRedmineTimeEntries(redmineApiClient, page + 1);
                        timeEntriesTail = timeEntriesTail.appendAll(timeEntriesNextPage);                        
                    }

                    resolve(timeEntriesTail);
                });
        })
    }

    async function createRedmineTimeEntry(redmineApiClient: RedmineApi.Client, params: RedmineApi.ParamsCreateOrUpdateTimeEntry) {
        return new Promise<void>((resolve, reject) => {
            logger.info(`Creating Redmine time entry ${JSON.stringify(params)}`);
            redmineApiClient.create_time_entry({time_entry: params},
                (err: any) => {
                    if (err !== null) {
                        const errorMsg = "Failed to create redmine time entry: " + JSON.stringify(err);
                        logger.error(errorMsg);
                        return reject(new Error(errorMsg));
                    }
                    logger.info(`Successfully created time entry"`);
                    resolve();
                });
        })
    }

    async function updateRedmineTimeEntry(redmineApiClient: RedmineApi.Client, timeEntryId: number, params: RedmineApi.ParamsCreateOrUpdateTimeEntry) {
        return new Promise<Vector<RedmineApi.Issue>>((resolve, reject) => {
            logger.info(`Updating Redmine time entry '${timeEntryId}' with data ${JSON.stringify(params)}`);
            redmineApiClient.update_time_entry(timeEntryId, {time_entry: params},
                (err: any) => {
                    if (err !== null) {
                        const errorMsg = "Failed to update redmine time entry: " + JSON.stringify(err);
                        logger.error(errorMsg);
                        return reject(new Error(errorMsg));
                    }
                    logger.info(`Successfully updated time entry`)
                    resolve();
                });
        })
    }
}
