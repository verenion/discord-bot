//Commands for interacting with the Nexus Mods API. 
// import requestPromise from 'request-promise-native'; //For making API requests
import axios, { AxiosError } from 'axios'; // For interactiing with API v1 and quicksearch. 
import { request, gql } from 'graphql-request'; // For interacting with API v2.
import { NexusUser } from '../types/users';
import { IGameListEntry, IValidateKeyResponse, IModInfo, IModFiles, IUpdateEntry, IChangelogs, IGameInfo } from '@nexusmods/nexus-api'
import { ModDownloadInfo, NexusSearchResult, NexusAPIServerError } from '../types/util';
import { logMessage } from './util';

const nexusAPI: string = 'https://api.nexusmods.com/'; //for all regular API functions
const nexusGraphAPI: string = nexusAPI+'/v2/graphql';
const nexusStatsAPI: string = 'https://staticstats.nexusmods.com/live_download_counts/mods/'; //for getting stats by game.

const v1headers = (apiKey: string) => ({
    'Application-Name': 'Nexus Mods Discord Bot',
    'Application-Version': process.env.npm_package_version || '0.0.0',
    'apikey': apiKey, 
});

async function v1APIQuery (path: string, apiKey: string, params?: { [key: string]: any }): Promise<any> {
    if (!apiKey) return Promise.reject(new Error('API Key Missing: Please link your Nexus Mods account to your Discord in order to use this feature. See `/link` for help.'));
    try {
        const query = await axios({
            baseURL: nexusAPI,
            url: path,
            transformResponse: (data) => JSON.parse(data),
            headers: v1headers(apiKey),
            params,
        });
        return query.data;
    }
    catch(err) {
        if (err as AxiosError) return Promise.reject(new NexusAPIServerError(err as AxiosError, path));
        logMessage('Unexpected API error', err, true);
        return Promise.reject(new Error(`Unexpected API error: ${(err as Error)?.message}`));
    }
}

async function games(user: NexusUser, bUnapproved?: boolean): Promise<IGameInfo[]>  {
    return v1APIQuery('/v1/games', user?.apikey, { include_unapproved: bUnapproved });
}

async function gameInfo(user: NexusUser, domainQuery: string): Promise<IGameListEntry> {
    return v1APIQuery(`/v1/games/${domainQuery}`, user?.apikey);
}

export interface IValidateResponse extends IValidateKeyResponse {
    is_ModAuthor: boolean;
}

async function validate(apiKey: string): Promise<IValidateResponse> {
    const baseCheck: IValidateKeyResponse = await v1APIQuery('/v1/users/validate.json', apiKey);
    // We need to talk to GraphQL to see if this user is a mod author. 
    const is_ModAuthor: boolean = await getModAuthor(baseCheck.user_id);
    return { is_ModAuthor, ...baseCheck };
}

export async function getModAuthor(id: number): Promise<boolean> {
    const query = gql`
    query getModAuthorStatus($id: Int!) {
        user(id: $id) {
            name
            recognizedAuthor
        }
    }`;

    const variables = { id };
    
    try {
        const data = await request(nexusGraphAPI, query, variables, v1headers(''));
        return data?.user?.recognizedAuthor;
    }
    catch(err) {
        logMessage('GraphQL request for mod author status failed', { error: (err as Error).message, userId: id }, true);
        return false;
    }
}

async function quicksearch(query: string, bIncludeAdult: boolean, game_id: number = 0): Promise<NexusSearchResult> {
    query = query.split(' ').toString();//query.replace(/[^A-Za-z0-9\s]/gi, '').split(' ').join(',');
    try {
        const searchQuery = await axios({
            baseURL: nexusAPI,
            url: '/mods',
            params: {
                terms: encodeURI(query),
                game_id,
                include_adult: bIncludeAdult,
            },
            transformResponse: (data) => JSON.parse(data),
            timeout: 15000
        });
        const results = {
            fullSearchURL: `https://www.nexusmods.com/search/?RH_ModList=nav:true,home:false,type:0,user_id:0,game_id:${game_id},advfilt:true,search%5Bfilename%5D:${query.split(',').join('+')},include_adult:${bIncludeAdult},page_size:20,show_game_filter:true`,
            ...searchQuery.data
        };
        // const searchQuery = await requestPromise({ url: nexusSearchAPI, qs: { terms: encodeURI(query), game_id, include_adult: bIncludeAdult }, timeout: 15000 });
        // let results = JSON.parse(searchQuery);
        // results.fullSearchURL = `https://www.nexusmods.com/search/?RH_ModList=nav:true,home:false,type:0,user_id:0,game_id:${game_id},advfilt:true,search%5Bfilename%5D:${query.split(',').join('+')},include_adult:${bIncludeAdult},page_size:20,show_game_filter:true`;
        return results;
    }
    catch(err) {
        return Promise.reject(err);
        // if ((err as Error).message.toLowerCase().includes('cloudflare')) return Promise.reject(new Error('Cloudflare error: Quicksearch request timed out.'));
        // return Promise.reject(new Error(`Nexus Mods Search API responded with ${(err as any).statusCode} while fetching results. Please try again later.`));
    }
}

async function updatedMods(user: NexusUser, gameDomain: string, period: string = '1d'): Promise<IUpdateEntry[]> {
    return v1APIQuery(`/v1/games/${gameDomain}/mods/updated.json`, user?.apikey, { period });
}

async function modInfo(user: NexusUser, gameDomain: string, modId: number): Promise<IModInfo> {
    return v1APIQuery(`/v1/games/${gameDomain}/mods/${modId}.json`, user?.apikey);
}

async function modFiles(user: NexusUser, gameDomain: string, modId: number): Promise<IModFiles> {
    return v1APIQuery(`/v1/games/${gameDomain}/mods/${modId}/files.json`, user?.apikey);
}

async function modChangelogs(user: NexusUser, gameDomain: string, modId: number): Promise<IChangelogs> {
    return v1APIQuery(`/v1/games/${gameDomain}/mods/${modId}/changelogs.json`, user?.apikey);
}

class downloadStatsCache {
    private downloadStats: { [gameId: number]: { data: ModDownloadInfo[], expires: Date } };
    private cacheExpiryTime: number;
    
    constructor() {
        this.downloadStats = {};
        this.cacheExpiryTime = (5*60*1000);
    }

    saveGameStats(id: number, data: ModDownloadInfo[]) {
        const expires = new Date(new Date().getTime() + this.cacheExpiryTime);
        this.downloadStats[id] = { data, expires };
    }

    getStats(gameId: number, modId?: number): ModDownloadInfo[] | ModDownloadInfo | undefined {
        const game = this.downloadStats[gameId];
        // If nothing in the cache
        if (!game) return undefined;
        // Check if it has expired
        if (!!game && game.expires < new Date()) {
            delete this.downloadStats[gameId];
            logMessage('Clearing cached download stats for Game ID:', gameId);
            return undefined;
        }
        // If there's no game data or mod ID return whatever we found.
        if (modId == -1) return game.data;

        // Find the mod.
        const mod = game.data.find(m => m.id === modId);
        return mod || ({ id: modId, unique_downloads: 0, total_downloads: 0 } as ModDownloadInfo);
    }

    cleanUp() {
        // Clear out old cache entries
        const startSize = JSON.stringify(this.downloadStats).length;
        // logMessage('Clearing up download stats cache', { size: JSON.stringify(this.downloadStats).length });
        Object.entries(this.downloadStats)
        .map(([key, entry]: [string, { data: ModDownloadInfo[], expires: Date }]) => {
            const id: number = parseInt(key);
            if (entry.expires < new Date()) {
                logMessage('Removing expired cache data for game ', id);
                delete this.downloadStats[id]
            };
        });
        const endSize = JSON.stringify(this.downloadStats).length;
        const change = endSize - startSize;
        if (startSize != endSize) logMessage('Clean up of download stats cache done', { change });
    }
}

const downloadCache = new downloadStatsCache();

async function getDownloads(user: NexusUser, gameDomain: string, gameId: number = -1, modId: number = -1): Promise<ModDownloadInfo | ModDownloadInfo[]> {
    try {
        const gameList: IGameListEntry[] = await games(user, false);
        const game: IGameListEntry | undefined = gameList.find(game => (gameId !== -1 && game.id === gameId) || (gameDomain === game.domain_name));
        if (!game) return Promise.reject(`Unable to resolve game for ${gameId}, ${gameDomain}`);
        gameId = game.id;
        // Check for a cached version of the stats
        const cachedValue = downloadCache.getStats(gameId, modId);
        if (!!cachedValue) {
            downloadCache.cleanUp();
            return cachedValue;
        }
        // Get stats CSV
        const statsCsv = await axios({ baseURL: nexusStatsAPI, url: `${gameId}.csv`, responseEncoding: 'utf8' }); //({ url: `${nexusStatsAPI}${gameId}.csv`, encoding: 'utf8' });
        // const statsCsv = await requestPromise({ url: `${nexusStatsAPI}${gameId}.csv`, encoding: 'utf8' });
        // Map into an object
        const gameStats: ModDownloadInfo[] = statsCsv.data.split(/\n/).map(
            (row: string) => {
                if (row === '') return;
                const values = row.split(',');
                if (values.length != 4) {
                    // Since 2021-04-28 the CSV now includes page views as the 4th value.
                    logMessage(`Invalid CSV row for ${game.domain_name} (${gameId}): ${row}`);
                    return;
                }
                return {
                    id: parseInt(values[0]),
                    total_downloads: parseInt(values[1]),
                    unique_downloads: parseInt(values[2])
                }
            }
        ).filter((info: ModDownloadInfo | undefined) => info !== undefined);

        // Save to cache
        downloadCache.saveGameStats(gameId, gameStats);
        downloadCache.cleanUp();
        return downloadCache.getStats(gameId, modId) || { id: modId, total_downloads: 0, unique_downloads: 0 };
    }
    catch(err) {
        return Promise.reject(`Could not retrieve download data for ${gameDomain} (${gameId}) ${modId} \n ${err}`);
    }
}

export { games, gameInfo, validate, quicksearch, updatedMods, modInfo, modFiles, modChangelogs, getDownloads };