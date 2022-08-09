import { Client, Collection, ApplicationCommandData, GatewayIntentBits, Routes, Snowflake } from 'discord.js';
import { REST } from '@discordjs/rest';
import * as fs from 'fs';
import path from 'path';
import { logMessage } from './api/util';
import { DiscordEventInterface, DiscordInteraction, ClientExt } from './types/DiscordTypes';

const intents: GatewayIntentBits[] = [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.DirectMessages, 
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildIntegrations
];

export class DiscordBot {
    private static instance: DiscordBot;

    private token: Snowflake = process.env.D_TOKEN as Snowflake;
    private clientId: Snowflake = process.env.CLIENT_ID as Snowflake;
    private client: ClientExt = new Client({ intents });
    private rest: REST = new REST({ version: '10' }).setToken(this.token);

    private constructor() {
        this.initializeClient();
    }

    static getInstance(): DiscordBot {
        if (!DiscordBot.instance) {
            DiscordBot.instance = new DiscordBot();
        }

        return DiscordBot.instance;
    }

    private initializeClient(): void {
        if (!this.client) return logMessage('Could not initialise DiscordBot, client is not defined.', {}, true);
        
        this.client.config = require(path.join(__dirname, 'config.json'));
        this.client.application?.fetch();
        this.setEventHandler();
    }

    public async connect(): Promise<void> {
        logMessage('Attempting to log in.')
        try {
            await this.client.login(this.token);
            logMessage('Connected to Discord');
            await this.client.application?.fetch();
        }
        catch(err) {
            logMessage('Failed to connect to Discord during bot setup', { error: (err as Error).message }, true);
            return process.exit();
        }
    }

    public async setupInteractions(): Promise<void> {
        try {
            await this.setInteractions();
        }
        catch(err) {
            logMessage('Failed to set interactions', err, true);
        }
    }

    private setEventHandler(): void {
        try {
            const events: string[] = fs.readdirSync(path.join(__dirname, 'events'));
            events.filter(e => e.endsWith('.js')).forEach((file) => {
                const event: DiscordEventInterface = require(path.join(__dirname, 'events', file)).default;
                const eventName: string = file.split(".")[0];
                if (!event.execute) return;
                if (event.once) this.client.once(eventName, event.execute.bind(null, this.client));
                else this.client.on(eventName, event.execute.bind(null, this.client));
            });
            logMessage('Registered to receive events:', events.map(e => path.basename(e, '.js')).join(', '));
        }
        catch(err) {
            return logMessage('Error reading events directory during startup.', err, true);
        }
    }

    private async setInteractions(): Promise<void> {
        logMessage('Setting interaction commands');
        if (!this.client.interactions) this.client.interactions = new Collection();
        if (!this.client.application?.owner) await this.client.application?.fetch();
        
        const interactionFiles: string[] = fs.readdirSync(path.join(__dirname, 'interactions'))
            .filter(i => i.toLowerCase().endsWith('.js'));6

        let globalCommandsToSet : ApplicationCommandData[] = []; //Collect all global commands
        let guildCommandsToSet : {[guild: string] : ApplicationCommandData[]} = {}; // Collect all guild-specific commands. 
        let allInteractions : DiscordInteraction[] = [];

        // TODO! - Get the commands list per-server from the database 

        for (const file of interactionFiles) {
            const interaction: DiscordInteraction = require(path.join(__dirname, 'interactions', file)).discordInteraction;
            if (!interaction) continue;
            // Add all valid interactions to the main array.
            allInteractions.push(interaction);
            // Global commands should be added to the global list.
            if (interaction.public === true) globalCommandsToSet.push(interaction.command.toJSON());
            // If we can get this working, change it to a database of servers and unlisted interactions that are allowed.
            if (!!interaction.guilds) {
                for (const guild in interaction.guilds) {
                    if (!guildCommandsToSet[interaction.guilds[guild]]) guildCommandsToSet[interaction.guilds[guild]] = [];
                    guildCommandsToSet[interaction.guilds[guild]].push(interaction.command.toJSON());
                }
            }
            this.client.interactions?.set(interaction.command.name, interaction);
        }

        // Now we have the commands organised, time to set them up. 
        logMessage('Setting up interactions', { count: allInteractions.length });

        // Set global commands
        try {
            if (globalCommandsToSet.length) {
                await this.rest.put(
                    Routes.applicationCommands(this.clientId),
                    { body: globalCommandsToSet }
                );
            }
            else logMessage('No global commands to set', {}, true);
        }
        catch(err) {
            logMessage('Error setting global interactions', {err, commands: globalCommandsToSet.map(c => c.name)}, true);
            await this.client.application?.commands.set(globalCommandsToSet).catch(() => logMessage('Failed fallback command setter.'));
        }

        // Set guild commands
        for (const guildId of Object.keys(guildCommandsToSet)) {
            try {
                await this.rest.put(
                    Routes.applicationGuildCommands(this.clientId, guildId),
                    { body: guildCommandsToSet[guildId] }
                )
            }
            catch(err) {
                const guild = await this.client.guilds.fetch(guildId).catch(() => undefined)
                logMessage('Error setting guild interactions', { guild: guild?.name || guildId, err, commands: guildCommandsToSet[guildId].map(c => c.name) }, true);
            }
        }

        
    }

    // private async setSlashCommands(): Promise<void> {
    //     logMessage('Settings slash commands');
    //     if (!this.client.interactions) this.client.interactions = new Collection();
    //     if (!this.client.application?.owner) await this.client.application?.fetch();

    //     const interactionFiles: string[] = fs.readdirSync(path.join(__dirname, 'interactions'))
    //         .filter(i => i.toLowerCase().endsWith('.js'));
        
    //     let globalCommandsToSet : ApplicationCommandData[] = []; //Collect all global commands
    //     let guildCommandsToSet : {[guild: string] : ApplicationCommandData[]} = {}; // Collect all guild-specific commands. 
    //     let allInteractions : DiscordInteraction[] = [];
        
    //     interactionFiles.forEach(async (file: string) => {
    //         let interact: DiscordInteraction = require(path.join(__dirname, 'interactions', file))?.discordInteraction;
    //         if (!!interact) {
    //             allInteractions.push(interact);
    //             // let interName: string = file.split('.')[0];
    //             // Add to global commands list.
    //             if (interact.public) globalCommandsToSet.push(interact.command.toJSON());
    //             // Add as guild specific command
    //             if (!!interact.guilds) {
    //                 for (const guild in interact.guilds) {
    //                     if (!guildCommandsToSet[interact.guilds[guild]]) guildCommandsToSet[interact.guilds[guild]] = [];
    //                     guildCommandsToSet[interact.guilds[guild]].push(interact.command.toJSON());
    //                 }
    //             }
    //             this.client.interactions?.set(interact.command.name, interact);
    //         }
    //     });

    //     // We've collected our commands, now we need to set them.

    //     // Set globally
    //     try {
    //         const globalCommands: Collection<any, ApplicationCommand<any>>|undefined = await this.client.application?.commands.set(globalCommandsToSet);
    //         logMessage(`Set global slash commands: `, globalCommands?.map(c => c.name).join(', '));
    //         if (!globalCommands) throw new Error('No global commands set!');
    //         // const currentGuilds = (await this.client.guilds.fetch())
    //         // const permissionsToSet: {id: string, guildId: string, permissions: ApplicationCommandPermissionData[]}[] = globalCommands.reduce(
    //         //     (result: {id: string, guildId: string, permissions: ApplicationCommandPermissionData[]}[], command) => {
    //         //         const id = command.id;
    //         //         const interactionData = allInteractions.find(i => i.command.name === command.name);
    //         //         const permissions = interactionData?.permissions?.filter(p => !p.guild);
    //         //         if (permissions && permissions.length) {
    //         //             const cleanedPerms: ApplicationCommandPermissionData[] = permissions.map(p => ({ id:p.id, type: p.type, permission: p.permission }))
    //         //             const perGuildPerms = currentGuilds.map((g, guildId) => ({ id, guildId, permissions: cleanedPerms }));

    //         //             result = [...result, ...perGuildPerms];
    //         //         };
    //         //         return result;
    //         //     },
    //         //     []
    //         // );
    //         // logMessage('Global permissions to set', permissionsToSet);
    //         // await Promise.all(permissionsToSet.map(async pset => {
    //         //     const command = globalCommands.get(pset.id);
    //         //     try {
    //         //         await command?.permissions.add({ permissions: pset.permissions, guildId: pset.guildId });
    //         //         logMessage('Set global permissions for command', command?.name);
    //         //     }
    //         //     catch(err) {
    //         //         logMessage('Could not set permissions for command', { command: command?.name, err });
    //         //     }
    //         // }))
    //     }
    //     catch(err) {
    //         logMessage('Failed to set global slash command list', {err}, true);
    //     }

        
    //     // Set guild specific commands
    //     const guildToSet = Object.keys(guildCommandsToSet);

    //     for(const guildId of guildToSet) {
    //         const guildCommandList: ApplicationCommandData[] = guildCommandsToSet[guildId]
    //         // UNCOMMENT WHEN READY, FILER DUPLICATE PUBLIC COMMANDS (for testing we want them to duplicate due to the delay in updating commands in Discord).
    //             .filter(c => !globalCommandsToSet.find(gc => gc.name === c.name));

    //         const guild: Guild | undefined = this.client.guilds.cache.get(guildId as Snowflake);

    //         if (!guild) {
    //             logMessage('Unable to set up slash commands for invalid guild', {guildId}, true);
    //             continue;
    //         }

    //         if (!guildCommandList.length) {
    //             logMessage(`No non-global commands for ${guild?.name}, skipping.`);
    //             await guild.commands.set([]).catch(err => logMessage(`Unable to reset guild command list for ${guild.name}`, err, true));
    //             continue;
    //         };

    //         try {
    //             await guild.commands.set(guildCommandList);
    //             logMessage(`Set guild slash commands for ${guild.name}:`, guildCommandList.map(c => c.name).join(', '));

    //         }
    //         catch(err) {
    //             logMessage(`Failed to set up guild slash commands for ${guild?.name}`, err, true)
    //         }
    //     }

    //     return;
    // }
}