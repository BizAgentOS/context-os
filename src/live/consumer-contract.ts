import type { Data } from "../agent/contracts.ts";

/** This catalog drives HTTP documentation and the stdio bridge. */
export const consumerOperations = [
  {
    name: "describe_catalog",
    path: "/v3/catalog",
    description: "Discover permitted object types.",
    parameters: [],
  },
  {
    name: "describe_type",
    path: "/v3/types",
    description: "Describe permitted fields, relations and evidence scopes.",
    parameters: ["type","viewVersion"],
  },
  {
    name: "query_objects",
    path: "/v3/objects",
    description:
      "Read permitted objects or a named relation. Fields refer to the target type and must include $id. Source readings are not atomic. Use viewVersion from catalog to pin this investigation; it is required after migration.",
    parameters: ["type", "id", "relation", "fields", "offset", "limit", "viewVersion"],
  },
  {
    name: "read_evidence",
    path: "/v3/evidence",
    description:
      "Read an opaque evidenceRef returned by a permitted query or the explicit contextEvidence catalog. This is a saved reading, not current source values.",
    parameters: ["ref","viewVersion"],
  },
  {
    name: "describe_connection",
    path: "/v3/connection",
    description:
      "Read the permitted OpenAPI contract and HTTP/MCP examples. Keys are placeholders.",
    parameters: [],
  },
] as const;

export function consumerConnection(
  grants: Data[],
  origin: string,
  bridgePath: string,
  nodePath: string,
  contextEvidence: Data[] = [],
  viewVersion?:number,
  requiresViewVersion = false,
) {
  const types = grants.map((g) => String(g.type));
  const jsonValue = {
    type: ["string", "number", "boolean", "object", "array", "null"],
  };
  const reference = { type: "string", minLength: 1, maxLength: 200 };
  const versionRef = {
    type: "object",
    required: ["id", "version"],
    properties: { id: reference, version: { type: "integer", minimum: 1 } },
  };
  const coverage = {
    type: "object",
    required: ["offset", "shown", "total", "complete"],
    properties: {
      offset: { type: "integer" },
      shown: { type: "integer" },
      total: { type: ["integer", "null"] },
      complete: { type: "boolean" },
      sourceComplete: { type: "boolean", description: "For pinned snapshots, whether synchronization covered the full source." },
      snapshotTotal: { type: "integer", description: "Matching rows within the saved snapshot. If sourceComplete is false, total is unknown and complete remains false." },
    },
  };
  const common = {
    contractVersion: { const: "v3" },
    viewRef: versionRef,
    modelRef: versionRef,
    semanticRef: { anyOf: [versionRef, { type: "null" }] },
    methodVersion: { type: "string" },
    relationPolicy: { const: "source_mapping_only" },
    evidenceAvailability: { enum: ["not_exposed", "scoped_reading"] },
  };
  const objectVariants = grants.map((g) => {
    const evidenceFields =
      ((g.evidence as Data | undefined)?.fields as string[] | undefined) ?? [];
    const properties = Object.fromEntries(
      (g.fields as string[])
        .filter((f) => f !== "$id")
        .map((f) => [
          f,
          {
            type: "object",
            required: ["value", "status"],
            properties: {
              value: jsonValue,
              status: {
                enum: ["resolved", "missing", "conflict", "uncertain"],
              },
              ...(evidenceFields.includes(f) ? { evidenceRef: reference } : {}),
            },
          },
        ]),
    );
    return {
      type: "object",
      required: ["objectRef", "properties"],
      properties: {
        objectRef: {
          type: "object",
          required: ["type", "id"],
          properties: { type: { const: g.type }, id: reference },
        },
        properties: { type: "object", additionalProperties: false, properties },
      },
    };
  });
  const payloads: Record<string, Data> = {
    query_objects: {
      type: { enum: types },
      items: { type: "array", maxItems: 20, items: { oneOf: objectVariants } },
      coverage,
      relationEvidenceRef: reference,
      consistency: { enum: ["on_demand_not_atomic", "pinned_snapshot", "pinned_snapshot_with_on_demand"] },
      reads: {
        type: "array",
        items: {
          type: "object",
          properties: {
            readAt: { type: "string", format: "date-time" },
            historicalReplay: { type: "boolean" },
          },
        },
      },
    },
    describe_catalog: {
      types: {
        type: "array",
        maxItems: 20,
        items: { type: "object", properties: { name: { enum: types } } },
      },
      coverage: { type: "object" },
      contextEvidence: {
        type: "array",
        maxItems: 6,
        items: {
          type: "object",
          properties: {
            ref: reference,
            kind: { enum: ["document", "metric"] },
            label: { type: "string" },
          },
        },
      },
    },
    describe_type: {
      type: { enum: types },
      fields: {
        type: "array",
        items: {
          enum: [...new Set(grants.flatMap((g) => g.fields as string[]))],
        },
      },
      relations: { type: "array", items: { type: "object" } },
      evidence: { type: "object" },
      limits: { type: "object" },
    },
    read_evidence: {
      evidenceRef: reference,
      reading: { const: "saved_reading_not_current" },
      expiresAt: { type: "string", format: "date-time" },
      evidence: {
        type: "object",
        properties: {
          kind: { enum: ["property", "relation", "document", "metric"] },
          value: jsonValue,
          status: { enum: ["resolved", "missing", "conflict", "uncertain"] },
          observations: { type: "array" },
          matches: { type: "array" },
          objectCoverage: coverage,
          coverage: { type: "object" },
          location: { type: "object" },
          definition: { type: "object" },
          items: { type: "array" },
          reads: { type: "array" },
        },
      },
    },
    describe_connection: {
      openapi: { type: "object" },
      http: { type: "object" },
      mcp: { type: "object" },
      workflow: { type: "array" },
    },
  };
  const resultSchema = (op: string): Data => ({
    type: "object",
    required: ["contractVersion", "viewRef", "modelRef"],
    properties: { ...common, ...payloads[op] },
  });
  const paths = Object.fromEntries(
    consumerOperations.map((op) => [
      op.path,
      {
        get: {
          operationId: op.name,
          description: op.description,
          parameters: op.parameters.map((p) => ({
            name: p,
            in: "query",
            required: p === "type" || p === "ref" || (p === "viewVersion" && requiresViewVersion),
            schema:
              p === "limit"
                ? { type: "integer", minimum: 1, maximum: 20, default: 20 }
                : p === "viewVersion"?{type:"integer",minimum:1,description:"Use viewRef.version from catalog; required after migration."}:p === "offset"
                  ? { type: "integer", minimum: 0, default: 0 }
                  : {
                      type: "string",
                      ...(p === "type" ? { enum: types } : {}),
                    },
            ...(p === "fields"
              ? {
                  description:
                    "Comma-separated permitted target fields, including $id. Omit for all permitted fields.",
                }
              : {}),
          })),
          responses: Object.fromEntries(
            [200, 400, 403, 404, 409, 502].map((status) => [
              status,
              {
                description:
                  status === 200
                    ? "Permitted result"
                    : status === 403
                      ? "Invalid key, unpermitted scope or revoked view"
                      : status === 400
                        ? "Invalid query"
                        : status === 409 ? "View version changed or required; rediscover catalog." : status === 404
                          ? "Unknown endpoint"
                          : "Source or fixed model unavailable",
                content: {
                  "application/json": {
                    schema:
                      status === 200
                        ? resultSchema(op.name)
                        : {
                            type: "object",
                            required: ["error"],
                            properties: { error: { type: "string" } },
                          },
                  },
                },
              },
            ]),
          ),
        },
      },
    ]),
  );
  return {
    contextEvidence,
    openapi: {
      openapi: "3.1.0",
      info: { title: "Data Engine permitted view", version: "v3" },
      servers: [{ url: origin }],
      security: [{ consumerKey: [] }],
      components: {
        securitySchemes: { consumerKey: { type: "http", scheme: "bearer" } },
      },
      paths,
      "x-permitted-grants": grants,
      "x-context-evidence": contextEvidence,
    },
    http: {
      catalog: `${origin}/v3/catalog`,
      objects: `${origin}/v3/objects?type=${encodeURIComponent(types[0])}${viewVersion?"&viewVersion="+viewVersion:""}`,
      authorization: "Bearer <DATAENGINE_CONSUMER_KEY>",
      evidence: `${origin}/v3/evidence?ref=<evidenceRef>${viewVersion?"&viewVersion="+viewVersion:""}`,
      example: `const response = await fetch(${JSON.stringify(origin + "/v3/objects?type=" + encodeURIComponent(types[0])+(viewVersion?"&viewVersion="+viewVersion:""))}, {headers: {Authorization: 'Bearer ' + process.env.DATAENGINE_CONSUMER_KEY}});\nif (!response.ok) throw new Error('Data Engine status ' + response.status);\nconsole.log(await response.json());`,
    },
    mcp: {
      mcpServers: {
        dataengine: {
          command: nodePath,
          args: [bridgePath],
          env: {
            DATAENGINE_URL: origin,
            DATAENGINE_CONSUMER_KEY: "<本视图 API Key>",
          },
        },
      },
    },
    workflow: [
      "describe_catalog",
      "describe_type",
      "query_objects",
      "read_evidence",
    ],
    limitations: [
      "Local stdio bridge; no hosted MCP endpoint.",
      "Evidence is a saved, permission-filtered reading; no source configuration or raw record identifiers.",
      "No document/metric bodies are implicitly authorized by object fields.",
      "Relations use source mappings only; no automatic publication of internal corrections.",
    ],
  };
}
