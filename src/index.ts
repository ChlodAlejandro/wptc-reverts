import getAppDataPath from "appdata-path";
import Logger from "bunyan";
import bunyanFormat from "bunyan-format";
import {TwitterApi} from "twitter-api-v2";
import path from "path";
import prompts from "prompts";
import * as fs from "fs";
import WikimediaStream from "wikimedia-streams";
import cheerio from "cheerio";
import {mwn} from "mwn";

class WPTCReverts {

    static readonly TWEET_URL = "https://en.wikipedia.org/wiki/Special:Diff/{{{diff}}}";
    static readonly TWEET_TEXT =
        `New revert by {{{user}}} on "{{{title}}}": "{{{summary}}}" ${WPTCReverts.TWEET_URL}`;
    static readonly TWEET_TEXT_EMPTY =
        `New revert by {{{user}}} on "{{{title}}}" with no given reason. ${WPTCReverts.TWEET_URL}`;

    private static _i : WPTCReverts;
    public static get i() : WPTCReverts {
        return this._i ?? (this._i = new WPTCReverts());
    }

    log = Logger.createLogger({
        name: "WPTC Reverts",
        level: process.env.NODE_ENV === "development" ? 10 : 30,
        stream: bunyanFormat({
            outputMode: "short",
            levelInString: true
        }, process.stdout)
    });
    twitter: TwitterApi;
    stream: WikimediaStream;
    mwn: mwn;

    pages: string[] = [];

    private constructor() { /* ignored */ }

    async start() : Promise<void> {
        this.log.info(`Bot starting (${new Date().toUTCString()})...`);
        await this.setup();

        this.mwn = await mwn.init({
            apiUrl: "https://en.wikipedia.org/w/api.php",

            username: process.env.ENWIKI_USERNAME,
            password: process.env.ENWIKI_PASSWORD,

            userAgent: "wptc-reverts/1.0.0 (User:Chlod; wiki@chlod.net)",
            defaultParams: {
                maxlag: 60
            },
            silent: true
        });
        await this.getPages();
        setInterval(() => { this.getPages(); }, 600000);

        this.stream = new WikimediaStream("mediawiki.recentchange");
        this.stream.on("open", () => {
            this.log.info("Listening!");
        });
        this.stream.on("error", () => {
            this.log.info("An error occurred with the stream!");
        });
        this.stream.on("mediawiki.recentchange", (change) => {
            if (change.wiki !== "enwiki" || change.type !== "edit")
                return;
            if (!this.pages.includes(change.title))
                return;

            if (change.comment.includes("([[WP:HG|HG]])") || change.user === "ClueBot NG")
                return;
            if (/rv[vd]|vand(alism)?/gi.test(change.comment))
                return;

            const $ = cheerio.load(change.parsedcomment);
            const summary = $.root().text();

            const signatures = [
                // Rollback
                /^Reverted \d+ edits? by .+? \(talk\) to last version by .+? \(talk\)/g,
                // Undo
                /^Undid revision .+? by .+? \(talk\) ?/g,
                // RedWarn
                /^Reverting edit\(s\) by .+ to rev. .+ \d+ by .+?(: ?)?/g,
                // Twinkle
                /^Reverted \d+ edits? by .+ (talk)(: ?|$)/g
            ];

            if (!signatures.some(v => v.test(summary)))
                return;

            let strippedSummary = summary;
            for (const sig of signatures)
                strippedSummary = strippedSummary.replace(
                    new RegExp(sig.source, sig.flags), ""
                );

            // Strip talk links
            strippedSummary = strippedSummary.replace(/ ?\(talk\)/g, "");

            this.log.info(`Found new edit by ${change.user} (${
                change.revision.new
            }): ${summary}`);

            if (strippedSummary.length > 0) {
                const nonSummaryLength = 280 - WPTCReverts.TWEET_TEXT
                    .replace(/{{{user}}}/g, change.user)
                    .replace(/{{{title}}}/g, change.title)
                    .replace(/{{{summary}}}/g, "")
                    .replace(/https:.+$/g, "-".repeat(24)).length;

                this.twitter.v1.tweet(
                    WPTCReverts.TWEET_TEXT
                        .replace(/{{{user}}}/g, change.user)
                        .replace(/{{{title}}}/g, change.title)
                        .replace(/{{{summary}}}/g, strippedSummary.substr(0, nonSummaryLength))
                        .replace(/{{{diff}}}/g, `${change.revision.new}`)
                );
            } else {
                this.twitter.v1.tweet(
                    WPTCReverts.TWEET_TEXT_EMPTY
                        .replace(/{{{user}}}/g, change.user)
                        .replace(/{{{title}}}/g, change.title)
                        .replace(/{{{diff}}}/g, `${change.revision.new}`)
                );
            }
        });
    }

    async getPages() : Promise<void> {
        this.log.info("Getting pages...");
        const queries = await this.mwn.continuedQuery({
            "action": "query",
            "format": "json",
            "formatversion": "2",
            "titles": "User:Zoomiebot/WPTC Indexer/Complete",
            "prop": "links",
            "pllimit": "500"
        }, Number.POSITIVE_INFINITY);
        this.pages = queries.reduce(
            (p, q) => {
                p.push(...Object.values(q.query["pages"])[0]["links"].map(l => l["title"]));
                return p;
            }, <string[]>[]
        );
        this.log.info(`Pages received, found ${this.pages.length}.`);
    }

    async setup() : Promise<void> {
        this.log.info("Checking for credentials...");
        const configPath = path.join(getAppDataPath(), "wptc-reverts.conf");
        let config;
        try {
            config = JSON.parse(fs.readFileSync(configPath).toString("utf8"));
        } catch {
            config = {};
        }

        if (config["accessToken"] && config["accessSecret"]) {
            this.twitter = new TwitterApi({
                appKey: process.env.TWITTER_API_KEY,
                appSecret: process.env.TWITTER_API_SECRET,
                accessToken: config["accessToken"],
                accessSecret: config["accessSecret"]
            });
        } else {
            this.log.info("Login information not found. Requesting token...");
            const {
                oauth_token: oauthToken,
                oauth_token_secret: oauthSecret,
                url
            } = await (this.twitter = await new TwitterApi({
                appKey: process.env.TWITTER_API_KEY,
                appSecret: process.env.TWITTER_API_SECRET
            })).generateAuthLink();
            this.log.info();
            this.log.info("Open the following link in your browser and authenticate the app:");
            this.log.info(`  ${url}`);
            this.log.info("After this, copy the PIN presented and enter it below.");
            this.log.info();
            const { pin } = await prompts({
                name: "pin",
                type: "number",
                message: "PIN"
            });

            const { accessToken, accessSecret, client } = await new TwitterApi({
                appKey: process.env.TWITTER_API_KEY,
                appSecret: process.env.TWITTER_API_SECRET,
                accessToken: oauthToken,
                accessSecret: oauthSecret
            }).login(pin);
            this.twitter = client;
            fs.writeFileSync(configPath, JSON.stringify({ accessToken, accessSecret }));
        }

        this.log.info("Verifying identity...");
        this.log.info(`Logged in user: ${(await this.twitter.currentUser()).screen_name}`);
    }

}

WPTCReverts.i.start();
