"use strict";
import "@citizenfx/server";

import type { MySQLDatabase } from "@server/database/mysql";
import type { Config } from "@server";
import type Logger from "@ptkdev/logger";

import MySQL from "@server/database/mysql";

// prettier-ignore
type DatabaseDriverUsed = 
    DatabaseDriver extends "mysql"
        ? MySQLDatabase
    : DatabaseDriver extends "sqlite"
        ? never
    : DatabaseDriver extends "mongodb"
        ? never
    : DatabaseDriver extends "postgresql"
        ? never
    : never;

export default function Database(config: Config, logger: Logger): DatabaseDriverUsed {
    switch (config["#database"].driver) {
        case "mysql":
        default:
            return MySQL(config, logger) as any;
    }
}