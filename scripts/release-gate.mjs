import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REPOSITORY = "BizAgentOS/context-os";
const PUBLISHER = "NoraJing";
const PUBLISHER_ID = "46467776";

export function validateRequest(environment, inputs) {
  if (environment.GITHUB_REPOSITORY !== REPOSITORY ||
      environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      environment.GITHUB_REF !== "refs/heads/main" ||
      environment.GITHUB_ACTOR !== PUBLISHER ||
      environment.GITHUB_ACTOR_ID !== PUBLISHER_ID ||
      environment.GITHUB_TRIGGERING_ACTOR !== PUBLISHER) {
    throw new Error("Only NoraJing may publish from main in BizAgentOS/context-os; reruns have the same restriction.");
  }
  const tag = typeof inputs?.tag === "string" ? inputs.tag.trim() : "";
  const sha = typeof inputs?.commit_sha === "string" ? inputs.commit_sha.trim().toLowerCase() : "";
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) || tag.length > 128) {
    throw new Error("tag must be a stable semantic version such as v0.3.2; prereleases are not supported by this workflow.");
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("commit_sha must be the complete reviewed 40-character commit SHA.");
  return { tag, sha, version: tag.slice(1) };
}

export async function verifyRelease(request, api) {
  const { sha, tag, version } = request;
  const commit = await api("GET", `/git/commits/${sha}`);
  if (commit.sha !== sha) throw new Error("The requested commit could not be resolved exactly.");
  const comparison = await api("GET", `/compare/${sha}...main`);
  if (!["ahead", "identical"].includes(comparison.status)) throw new Error("The reviewed commit must be present in main history.");
  const manifest = await api("GET", `/contents/package.json?ref=${sha}`);
  if (manifest.type !== "file" || manifest.encoding !== "base64" || typeof manifest.content !== "string") {
    throw new Error("Could not read package.json from the reviewed commit.");
  }
  const pkg = JSON.parse(Buffer.from(manifest.content, "base64").toString("utf8"));
  if (pkg.version !== version) throw new Error(`Tag ${tag} does not match package.json version ${String(pkg.version)} at the reviewed commit.`);
  const release = await api("GET", `/releases/tags/${encodeURIComponent(tag)}`, undefined, true);
  if (release) throw new Error("A release already exists for this tag. This workflow never overwrites releases.");
  // The tag endpoint may exclude drafts. Publish repeats this with a write token,
  // which can see drafts; a read-only token may only see published releases.
  for (let page = 1; ; page++) {
    const releases = await api("GET", `/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error("Could not list existing releases and drafts.");
    if (releases.some((item) => item.tag_name === tag)) {
      throw new Error("A release or draft already exists for this tag. This workflow never overwrites releases.");
    }
    if (releases.length < 100) break;
  }
  const reference = await api("GET", `/git/ref/tags/${encodeURIComponent(tag)}`, undefined, true);
  if (reference) await assertTagTarget(reference, sha, api);
  return { reference };
}

async function assertTagTarget(reference, expectedSha, api) {
  let object = reference.object;
  for (let depth = 0; object?.type === "tag" && depth < 10; depth++) {
    const annotatedTag = await api("GET", `/git/tags/${object.sha}`);
    object = annotatedTag.object;
  }
  if (object?.type !== "commit" || object.sha !== expectedSha) {
    throw new Error("The existing tag points to a different commit. It will not be moved or reused.");
  }
}

export async function publishRelease(request, api) {
  // Repeat all read-only checks immediately before the first write.
  const { reference } = await verifyRelease(request, api);
  if (!reference) {
    // Repository convention requires annotated version tags. The object and its
    // reference both pin the reviewed SHA; no branch name is used as target.
    // A concurrent tag creation fails instead of moving or updating a tag.
    const annotatedTag = await api("POST", "/git/tags", {
      tag: request.tag,
      message: `Context OS ${request.tag}\nReviewed and approved by ${PUBLISHER}.\nCommit: ${request.sha}`,
      object: request.sha,
      type: "commit",
    });
    if (!/^[0-9a-f]{40}$/.test(annotatedTag.sha)) throw new Error("GitHub did not return a valid annotated tag object.");
    await api("POST", "/git/refs", { ref: `refs/tags/${request.tag}`, sha: annotatedTag.sha });
  }
  const pinnedTag = await api("GET", `/git/ref/tags/${encodeURIComponent(request.tag)}`);
  await assertTagTarget(pinnedTag, request.sha, api);
  const release = await api("POST", "/releases", {
    tag_name: request.tag,
    target_commitish: request.sha,
    name: request.tag,
    draft: false,
    prerelease: false,
    make_latest: "true",
    generate_release_notes: true,
    body: `Reviewed and approved by ${PUBLISHER}.\n\nCommit: ${request.sha}\nWorkflow: https://github.com/${REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  });
  // A competing writer changing tags is outside this workflow's security boundary.
  // Detect that case and visibly fail rather than silently report success.
  await assertTagTarget(await api("GET", `/git/ref/tags/${encodeURIComponent(request.tag)}`), request.sha, api);
  return release;
}

async function main() {
  const phase = process.argv[2];
  if (!["verify", "publish"].includes(phase)) throw new Error("Expected verify or publish.");
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const request = validateRequest(process.env, event.inputs);
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("The workflow token is missing.");
  const api = async (method, path, body, allowMissing = false) => {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "context-os-release-gate",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (HTTP ${response.status}). No tags or releases are overwritten by this workflow.`);
    return response.json();
  };
  if (phase === "verify") {
    await verifyRelease(request, api);
    console.log(`Verified ${request.tag} at ${request.sha}. No changes made.`);
  } else {
    const release = await publishRelease(request, api);
    console.log(`Published ${release.html_url} at ${request.sha}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
