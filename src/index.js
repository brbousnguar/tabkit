#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_PORT_RANGE, parsePortRange } from "../extension/protocol.js";
import { ExtensionBridge } from "./bridge.js";
import { readPairingToken } from "./pairing.js";

const SEARCH_DEFAULT_FIELDS = [
  "summary",
  "description",
  "status",
  "issuetype",
  "project",
  "assignee",
  "reporter",
  "priority",
  "created",
  "updated"
];

const log = (message) => process.stderr.write(`[tabkit] ${message}\n`);

const bridge = new ExtensionBridge({
  token: readPairingToken(),
  ports: parsePortRange(process.env.TABKIT_PORTS || DEFAULT_PORT_RANGE),
  connectTimeoutMs: Number(process.env.TABKIT_CONNECT_TIMEOUT_MS) || undefined,
  log
});

const TOOLS = [
  {
    name: "atlassian_whoami",
    description:
      "Check the Chrome bridge: which Atlassian site the extension uses and which account is logged in there. Call it first when another tool fails.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "jira_get_issue",
    description:
      "Fetch a Jira issue by key with your logged-in Chrome session. Pass fields to get only those fields; expand: [\"changelog\"] adds the history of status, assignee and field changes.",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: { type: "string", description: "Issue key, e.g. PROJ-123" },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Field ids or names to return, e.g. [\"summary\", \"status\", \"customfield_10016\"]. Omit for all fields."
        },
        expand: {
          type: "array",
          items: { type: "string" },
          description: "Jira expand values, e.g. [\"changelog\"] or [\"renderedFields\"]"
        }
      },
      required: ["issueKey"]
    }
  },
  {
    name: "jira_search_issues",
    description:
      "Search Jira issues with JQL. Returns summary, description, status, issuetype, project, assignee, reporter, priority, created and updated, plus the fields you add. One page per call: while isLast is false, call again with the returned nextPageToken, and count every page before saying how many issues match.",
    inputSchema: {
      type: "object",
      properties: {
        jql: { type: "string", description: "JQL query" },
        maxResults: { type: "number", description: "Results per page, 1-100 (default 10)" },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Extra field ids or names, e.g. customfield_10016 (story points), customfield_10020 (sprint), fixVersions, labels"
        },
        nextPageToken: { type: "string", description: "The nextPageToken of the previous page" },
        defaultFields: {
          type: "boolean",
          description: "false returns only the fields listed in fields, without the description (default true)"
        }
      },
      required: ["jql"]
    }
  },
  {
    name: "confluence_get_page",
    description: "Fetch a Confluence page by id with your logged-in Chrome session.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "Confluence page id" },
        includeStorage: { type: "boolean", description: "Include the body in storage format (default true)" }
      },
      required: ["pageId"]
    }
  }
];

async function callTool(name, args) {
  switch (name) {
    case "atlassian_whoami": {
      const me = await atlassian("GET", "/rest/api/3/myself");
      return {
        site: bridge.extension?.site,
        bridgePort: bridge.port,
        extensionVersion: bridge.extension?.version,
        accountId: me.accountId,
        displayName: me.displayName,
        emailAddress: me.emailAddress,
        timeZone: me.timeZone
      };
    }

    case "jira_get_issue": {
      const params = new URLSearchParams();
      const fields = optionalList(args, "fields");
      const expand = optionalList(args, "expand");
      if (fields.length) params.set("fields", fields.join(","));
      if (expand.length) params.set("expand", expand.join(","));
      const query = params.toString();
      return atlassian("GET", `/rest/api/3/issue/${encodeURIComponent(requireString(args, "issueKey"))}${query ? `?${query}` : ""}`);
    }

    case "jira_search_issues": {
      const fields = optionalList(args, "fields");
      const defaultFields = args.defaultFields !== false;
      return atlassian("POST", "/rest/api/3/search/jql", {
        jql: requireString(args, "jql"),
        maxResults: Math.min(Math.max(Math.trunc(Number(args.maxResults) || 10), 1), 100),
        fields: defaultFields ? [...new Set([...SEARCH_DEFAULT_FIELDS, ...fields])] : fields.length ? fields : ["summary"],
        ...(args.nextPageToken ? { nextPageToken: String(args.nextPageToken) } : {})
      });
    }

    case "confluence_get_page": {
      const expand = args.includeStorage === false ? "version,space" : "body.storage,version,space";
      return atlassian("GET", `/wiki/rest/api/content/${encodeURIComponent(requireString(args, "pageId"))}?expand=${expand}`);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function atlassian(method, path, body) {
  const response = await bridge.request(method, path, body);
  const data = parseBody(response);
  if (!response.ok) throw new Error(describeFailure(response, data));
  if (typeof data === "string" && /^\s*</.test(data)) {
    throw new Error(`Jira answered with an HTML page instead of JSON, usually the login page: log in to ${bridge.extension?.site} in Chrome.`);
  }
  return data;
}

function parseBody({ contentType, text }) {
  if (!text) return null;
  if (!contentType.includes("json")) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeFailure({ status }, data) {
  const site = bridge.extension?.site || "the Atlassian site";
  const details = [...(data?.errorMessages || []), ...Object.values(data?.errors || {}), data?.message]
    .filter(Boolean)
    .join("; ");
  const hint =
    status === 401
      ? ` Not logged in to ${site} in Chrome: log in there, then call the tool again.`
      : status === 403
        ? " Your Atlassian account is not allowed to do this."
        : "";
  return `Atlassian answered ${status}.${hint}${details ? ` ${details}` : ""}`;
}

function requireString(args, name) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name}`);
  return value.trim();
}

function optionalList(args, name) {
  const value = args[name];
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : String(value).split(",")).map((item) => String(item).trim()).filter(Boolean);
}

const server = new Server({ name: "tabkit", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const result = await callTool(request.params.name, request.params.arguments || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
});

// Listen before taking MCP calls; when every port is taken, start anyway so the tools can say why.
await bridge.listen().then(
  (port) => log(`waiting for the Chrome extension on 127.0.0.1:${port}`),
  (error) => log(error.message)
);
await server.connect(new StdioServerTransport());

const shutdown = () => bridge.close().finally(() => process.exit(0));
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
