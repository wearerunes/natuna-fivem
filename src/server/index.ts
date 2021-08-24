/**
 * @module Server
 * @category Server
 */

"use strict";

import config from "@/natuna.config.js";
import pkg from "@/package.json";

import fs from "fs";
import path from "path";
import util from "util";

import mysql from "mysql2";
import fetch from "node-fetch";
import figlet from "figlet";
import glob from "tiny-glob";

import CrypterWrapper from "@server/crypter";
import PlayersWrapper from "@server/players";
import CommandWrapper, * as Command from "@server/command";

import MySQL from "@server/database/mysql";
import Cassandra from "@server/database/cassandra";
import MongoDB from "@server/database/mongodb";

import Events from "@server/events";

// prettier-ignore
export type SelectedDatabaseDriver = 
    typeof config.core.db extends "mysql" ? 
        MySQL : 
        typeof config.core.db extends "cassandra" ?
            Cassandra : 
            typeof config.core.db extends "mongodb" ? 
                MongoDB : 
                MySQL;

export default class Server extends Events {
    /**
     * @description
     * Database function to execute classic SQL query
     *
     * @param query SQL query string to execute
     *
     * @example
     * ```ts
     * dbQuery('CREATE DATABASE IF NOT EXISTS databaseName');
     * ```
     */
    dbQuery: MySQL["utils"]["executeQuery"];

    /**
     * @description
     * Crypter to Encrypt or Decrypt your secret data
     */
    crypter: (algorithm: string, secretKey: string) => CrypterWrapper;

    /**
     * @description
     * Players wrapper
     */
    players: PlayersWrapper;

    /**
     * @hidden
     *
     * @description
     * Configurations
     */
    private config: typeof config;

    /**
     * @hidden
     *
     * @description
     * List of All Plugins (Client, Server, NUI)
     */
    private plugins: { [key: string]: Array<{ name: string; file?: string; config?: any }> };

    /**
     * @hidden
     *
     * @description
     * List of Server Plugins
     */
    private serverPlugins: { [key: string]: any };

    /**
     * @hidden
     *
     * @description
     * List of Registered Commands
     */
    private commands: { [key: string]: CommandWrapper };

    /**
     * @hidden
     */
    constructor() {
        super();
        this.config = config;
        this.plugins = {};
        this.serverPlugins = {};
        this.commands = {};

        this.dbQuery = this.db("").utils.executeQuery;
        this.crypter = (algorithm: string = this.config.core.crypter.algorithm, secretKey: string = this.config.core.crypter.secretKey) => new CrypterWrapper(algorithm, secretKey);
        this.players = new PlayersWrapper(this, this.config);

        this.addSharedEventHandler("natuna:server:registerCommand", this.registerCommand);
        this.addServerEventHandler("playerConnecting", this._events.playerConnecting);
        this.addServerEventHandler("onServerResourceStart", this._events.onServerResourceStart);
        this.addServerEventHandler("onServerResourceStop", this._events.onServerResourceStop);

        this.addSharedCallbackEventHandler("natuna:server:requestClientSettings", this._events.requestClientSettings);

        // Test database connection (on startup) <-- check if connection success or not, also executing default SQL 👍
        this.dbQuery(`CREATE DATABASE IF NOT EXISTS \`${this.config.core.db}\``);
    }

    /**
     * @description
     * Database wrapper
     */
    db = (table: string): SelectedDatabaseDriver => {
        switch (typeof config.core.db) {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            case "cassandra":
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore
                return new Cassandra();

            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            case "mysql":
            default:
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore
                return new MySQL(mysql.createConnection(this.config.core.db), table);
        }
    };

    /**
     * @description
     * Use this function to hold next script below this from executing before it finish the timeout itself
     *
     * @param ms Milisecond to wait
     *
     * @example
     * ```ts
     * const one = () => true; // Always use ES6 for better practice
     * const two = () => true;
     *
     * setTimeout(async() => { // Always do it on async
     *      one();
     *      await wait(5000); // Wait 5s (5000ms) before executing next function, always await it
     *      two(); // Executed after 5 second after wait before
     * });
     * ```
     */
    wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

    /**
     * @description
     * Registrating a command. If isClientCommand was set true, the handler would just triggering a client registered command
     *
     * @param name Name of the command
     * @param handler Function to executed
     * @param config Configuration of the command
     * @param isClientCommand Whether if the command was sent from client or not
     *
     * @example
     * ```ts
     * registerCommand(
     *      'hello',
     *      (src, args) => console.log('Hello!'),
     *      {
     *          description: "Say Hello"
     *      }
     * });
     * ```
     */
    registerCommand = (name: string | Array<string>, handler: Command.Handler, config: Command.Config = {}, isClientCommand = false) => {
        const addCommand = (name: string) => {
            // Throws an error when same server command was registered twice
            if (this.commands[name] && !isClientCommand) throw new Error(`Command "${name}" had already been registered before!`);

            emitNet("natuna:client:setCommandDescription", -1, name, config);

            // Return if client command was already registered before
            if (this.commands[name] && isClientCommand) return;
            this.commands[name] = new CommandWrapper(this, name, handler, config, isClientCommand);
        };

        if (Array.isArray(name)) {
            for (const alias of name) {
                addCommand(alias);
            }
        } else {
            addCommand(name);
        }
        return true;
    };

    /**
     * @hidden
     * @readonly
     *
     * @description
     * Logger to Console
     *
     * @param text Text to logs
     */
    _logger = (...text: any) => {
        return console.log("\x1b[33m%s\x1b[0m", "[🏝️ Natuna Framework]", "[SERVER]", ...text);
    };

    /**
     * @hidden
     * @readonly
     *
     * @description
     * Loops through folder and retrieve every plugins file
     *
     * @param type Type of the plugin (Client or Server)
     */
    _getPlugins = async (type: string) => {
        let plugins: {
            [key: string]: {
                client?: Array<string>;
                server?: Array<string>;
                nui?: boolean;
            };
        } = {};

        const basePath = GetResourcePath(GetCurrentResourceName());

        let pluginList = await glob("plugins/*", {
            cwd: basePath,
        });

        for (const pluginPath of pluginList) {
            const pluginFullPath = path.join(basePath, pluginPath);

            if (fs.lstatSync(pluginFullPath).isDirectory()) {
                const pluginName = path.basename(pluginPath);
                const moduleTypeList = await glob("*", {
                    cwd: pluginFullPath,
                });

                plugins[pluginName] = {};

                for (const moduleType of moduleTypeList) {
                    const moduleTypePath = path.join(basePath, pluginPath, moduleType);

                    if (fs.lstatSync(moduleTypePath).isDirectory()) {
                        const modules = await glob("**/*.ts", {
                            cwd: moduleTypePath,
                        });

                        console.log(modules);
                    }
                }
            }
        }

        const getPlugins = async (type: string) => {
            const activePluginLists: Array<{
                name: string;
                file?: string;
                config?: any;
            }> = [];

            const readDirAsync = util.promisify(fs.readdir);
            const pluginsFolderPath = path.join(GetResourcePath(GetCurrentResourceName()), "plugins");
            const pluginLists = await readDirAsync(pluginsFolderPath);

            while (!this.config) await this.wait(1000);

            for (const pluginName of pluginLists) {
                try {
                    let manifest: any;

                    try {
                        manifest = require(`../../plugins/${pluginName}/manifest.ts`).default();
                    } catch (error) {
                        manifest = require(`../../plugins/${pluginName}/manifest.json`);
                    }

                    if (manifest && manifest.active) {
                        switch (type.toUpperCase()) {
                            case "CLIENT":
                            case "SERVER":
                                const config = this.config.plugins[pluginName] && this.config.plugins[pluginName][type] ? this.config.plugins[pluginName][type] : {};

                                if (manifest.plugins && manifest.plugins[type]) {
                                    for (const file of manifest.plugins[type]) {
                                        activePluginLists.push({ name: pluginName, file, config });
                                    }
                                }

                                break;
                            case "NUI":
                                const resourcePath = path.join(pluginsFolderPath, pluginName);
                                const resourceTypes = await readDirAsync(resourcePath);

                                if (resourceTypes.includes("ui")) {
                                    activePluginLists.push({ name: pluginName });
                                }

                                break;
                        }
                    }
                } catch (error) {
                    // Keep it empty to make sure the file finding process is still working on
                }
            }

            return activePluginLists;
        };

        return this.plugins[type] || (this.plugins[type] = await getPlugins(type));
    };

    /**
     * @hidden
     * @readonly
     *
     * @description
     * This function is to init a plugin, differs from the client ones, it's triggered whenever the script was ready
     */
    _initServerPlugins = async () => {
        this._logger(`Intializing Server Plugins`);
        const plugins = await this._getPlugins("server");

        let count = 1; // Start from 1
        for (const plugin of plugins) {
            this._logger(`Ensuring Plugins: ${count}. ${plugin.name}`);

            this.serverPlugins[plugin.name] = require(`../../plugins/${plugin.name}/server/${plugin.file}`);
            this.serverPlugins[plugin.name]._handler(this, plugin.config);

            count += 1;
        }
        this._logger("Server Plugins Ready!");
    };

    /**
     * @hidden
     * @readonly
     *
     * @description
     * Check package version and compare it to remote repository.
     */
    _checkPackageVersion = () => {
        return new Promise((resolve, reject) => {
            this._logger(`Welcome! Checking your version...`);
            this._logger(`You are currently using version ${pkg.version}.`);

            // Can't use async await, idk why :(
            fetch("https://raw.githack.com/natuna-framework/fivem/master/package.json")
                .then((res) => res.text())
                .then((data) => {
                    const rpkg: typeof pkg = JSON.parse(data);

                    const currentVersion = parseInt(pkg.version.replace(/\./g, ""));
                    const remoteVersion = parseInt(rpkg.version.replace(/\./g, ""));

                    if (currentVersion < remoteVersion) {
                        this._logger(`\x1b[31mYou are not using the latest version of Natuna Framework (${rpkg.version}), please update it!`);
                    } else if (currentVersion > remoteVersion) {
                        this._logger(`\x1b[31mYou are not using a valid version version of Natuna Framework!`);
                    } else if (currentVersion === remoteVersion) {
                        this._logger("\x1b[32mYou are using a latest version of Natuna Framework!");
                    }

                    return resolve(true);
                });
        });
    };

    /**
     * @hidden
     * @readonly
     *
     * @description
     * List of events on server
     */
    private _events = {
        /**
         * @description
         * Listen on whenever a player joining a session also validating that player before joining the session
         *
         * @param name The display name of the player connecting
         * @param setKickReason A function used to set a reason message for when the event is canceled.
         * @param deferrals An object to control deferrals.
         */
        playerConnecting: async (name: string, setKickReason: (reason: string) => any, deferrals: { [key: string]: any }) => {
            /**
             * @description
             * Getting player
             */
            deferrals.defer();
            const player = (global as any).source;

            deferrals.update(`[🏝 Natuna] Hello ${name}! Please wait until we verify your account.`);

            /**
             * @description
             * Checking License
             */
            const playerIds = this.players.utils.getIdentifiers(player);

            if (!playerIds.license || typeof playerIds.license == "undefined") {
                return deferrals.done("[🏝 Natuna] Your game license is invalid!");
            }

            this._logger(`Player ${name} Joining the server. (License ID: ${playerIds.license})`);

            /**
             * @description
             * Checking Whitelist Status
             */
            if (this.config.core.isWhitelisted) {
                const checkWhitelistStatus = await this.db("whitelist_lists").findFirst({
                    where: {
                        license: playerIds.license,
                    },
                });

                if (!checkWhitelistStatus) {
                    return deferrals.done("[🏝 Natuna] You are not whitelisted!");
                }
            }

            /**
             * @description
             * Checking Account
             */
            deferrals.update(`[🏝 Natuna] Finding your account in our database.`);

            const user = await this.db("users").findFirst({
                where: {
                    license: playerIds.license,
                },
            });

            const newCheckpointData = {
                last_ip: playerIds.ip.toString(),
                last_login: new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }).toString(),
            };

            /**
             * @description
             * Handling when account does not exist
             */
            // If account does not exist
            if (!user) {
                await this.db("users").write({
                    data: {
                        license: playerIds.license,
                        ...newCheckpointData,
                    },
                });
            }

            // If account exist
            else {
                // If user was banned
                const checkBanStatus = await this.db("ban_lists").findFirst({
                    where: {
                        license: playerIds.license,
                    },
                });

                if (checkBanStatus) {
                    return deferrals.done(checkBanStatus.reason);
                }

                // If not
                await this.db("users").update({
                    data: {
                        ...newCheckpointData,
                    },
                    where: {
                        license: playerIds.license,
                    },
                });
            }

            return deferrals.done();
        },

        /**
         * @description
         * Listen on whenever a player requested plugins to be setup on their client
         */
        requestClientSettings: async () => {
            const pluginLists = await this._getPlugins("client");
            const nuiLists = await this._getPlugins("nui");

            return {
                pluginLists,
                nuiLists,
                discordRPC: this.config.core.discordRPC,
                game: this.config.core.game,
                nui: this.config.core.nui,
                config: {
                    locationUpdateInterval: this.config.core.players.locationUpdateInterval,
                },
            };
        },

        /**
         * @description
         * Listen when Natuna Framework is starting
         */
        onServerResourceStart: async (resourceName: string) => {
            if (GetCurrentResourceName() == resourceName) {
                // Starting
                this.triggerServerEvent("natuna:server:starting");

                await new Promise((resolve) => {
                    figlet.text("Natuna Framework", {}, (err: Error, result: string) => {
                        console.log(result);
                        resolve(true);
                    });
                });

                await this._checkPackageVersion();

                // Initializing
                this.triggerServerEvent("natuna:server:initializing");

                this._logger("Starting Server...");
                await this._initServerPlugins();

                // Ready
                this.triggerServerEvent("natuna:server:ready");

                this._logger("Server Ready!");
            }
        },

        /**
         * @description
         * Listen when Natuna Framework is stopping
         */
        onServerResourceStop: (resourceName: string) => {
            if (GetCurrentResourceName() == resourceName) {
                // Stopping
                this.triggerServerEvent("natuna:server:stopped");
            }
        },
    };
}

new Server();
