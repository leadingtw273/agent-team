#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const endpoint = "https://api.linear.app/graphql";
const mode = process.argv[2];
const allowedModes = new Set(["inventory", "roundtrip"]);
const withUpload = process.argv.includes("--with-upload");
const keyPath =
  process.env.LINEAR_API_KEY_FILE ?? join(homedir(), ".agent-team", "secrets", "linear-api-key");
const requestTimeoutMs = 15_000;
let interrupted = false;
let activeRequestController = null;

class ProbeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function loadKey() {
  const metadata = await stat(keyPath);
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
  if (!isSecureSecretFile(metadata, currentUserId)) {
    throw new ProbeError("insecure_secret_file");
  }
  return parseLinearApiKey(await readFile(keyPath, "utf8"));
}

export function isSecureSecretFile(metadata, currentUserId) {
  return metadata.isFile() && (metadata.mode & 0o777) === 0o600 && metadata.uid === currentUserId;
}

export function parseLinearApiKey(raw) {
  const key = raw.trim();
  if (!/^lin_api_[A-Za-z0-9_-]+$/u.test(key)) {
    throw new ProbeError("invalid_secret_file");
  }
  return key;
}

export function classifyGraphqlOutcome(status, body) {
  if (status < 200 || status >= 300) return { ok: false, error: `http_${status}` };
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    if (body.data !== undefined && body.data !== null) {
      return { ok: false, error: "graphql_partial_error" };
    }
    const code = body.errors.find((error) => error?.extensions?.code)?.extensions?.code;
    return {
      ok: false,
      error: code ? `graphql_${String(code).toLowerCase()}` : "graphql_error",
    };
  }
  return { ok: true, error: null };
}

export function classifyNonJsonOutcome(status) {
  return `http_${status}_non_json`;
}

export function sanitizeProbeName(value) {
  return allowedModes.has(value) ? value : "invalid_mode";
}

async function fetchWithTimeout(url, options, { cleanup = false, readBody = false } = {}) {
  if (interrupted && !cleanup) throw new ProbeError("interrupted");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  activeRequestController = controller;
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!readBody) return response;
    return { response, bodyText: await response.text() };
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    if (controller.signal.aborted) {
      throw new ProbeError(interrupted && !cleanup ? "interrupted" : "request_timeout");
    }
    throw new ProbeError("network_error");
  } finally {
    clearTimeout(timeout);
    if (activeRequestController === controller) activeRequestController = null;
  }
}

async function request(key, query, variables = {}, options = {}) {
  const { response, bodyText } = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: { authorization: key, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    },
    { ...options, readBody: true },
  );
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new ProbeError(classifyNonJsonOutcome(response.status));
  }
  const outcome = classifyGraphqlOutcome(response.status, body);
  if (!outcome.ok) throw new ProbeError(outcome.error);
  return body.data;
}

const inventoryQuery = `
  query AgentTeamLinearInventory {
    viewer { id }
    organization { id }
    teams(first: 50) {
      nodes {
        id
        states(first: 50) { nodes { id type } pageInfo { hasNextPage } }
      }
      pageInfo { hasNextPage }
    }
    projects(first: 50) { nodes { id } pageInfo { hasNextPage } }
    templates { id }
    mutationType: __type(name: "Mutation") { fields { name } }
  }
`;

async function inventory(key) {
  const data = await request(key, inventoryQuery);
  const mutationNames = new Set(data.mutationType.fields.map((field) => field.name));
  const requiredMutations = [
    "issueCreate",
    "issueUpdate",
    "commentCreate",
    "commentDelete",
    "issueLabelCreate",
    "issueLabelDelete",
    "templateCreate",
    "templateDelete",
    "fileUpload",
    "fileUploadDangerouslyDelete",
  ];
  const teams = data.teams.nodes;
  const selectedTeam = teams[0] ?? null;
  const canceledStateId =
    selectedTeam?.states.nodes.find((state) => state.type === "canceled")?.id ?? null;
  const requiredMutationsPresent = requiredMutations.every((name) => mutationNames.has(name));
  const inventoryComplete =
    !data.teams.pageInfo.hasNextPage &&
    !data.projects.pageInfo.hasNextPage &&
    !(selectedTeam?.states.pageInfo.hasNextPage ?? false);
  const viewerReadable = Boolean(data.viewer?.id);
  const workspaceReadable = Boolean(data.organization?.id);
  const capabilitySuccess =
    viewerReadable &&
    workspaceReadable &&
    selectedTeam !== null &&
    canceledStateId !== null &&
    requiredMutationsPresent &&
    inventoryComplete;
  return {
    internal: {
      teamId: selectedTeam?.id ?? null,
      canceledStateId,
    },
    public: {
      success: capabilitySuccess,
      registrationReady: capabilitySuccess && data.projects.nodes.length > 0,
      connection: {
        viewerReadable,
        workspaceReadable,
      },
      inventory: {
        teamCount: teams.length,
        projectCount: data.projects.nodes.length,
        templateCount: data.templates.length,
        selectedTeamCanceledStateAvailable: canceledStateId !== null,
        inventoryComplete,
      },
      mutationsPresent: Object.fromEntries(
        requiredMutations.map((name) => [name, mutationNames.has(name)]),
      ),
    },
  };
}

async function createLabel(key, input) {
  const data = await request(
    key,
    `mutation CreateProbeLabel($input: IssueLabelCreateInput!) {
      issueLabelCreate(input: $input) {
        success
        issueLabel { id isGroup parent { id } team { id } }
      }
    }`,
    { input },
  );
  if (!data.issueLabelCreate.success) throw new ProbeError("label_create_unsuccessful");
  return data.issueLabelCreate.issueLabel;
}

async function runRoundTrip(key) {
  const discovered = await inventory(key);
  const { teamId, canceledStateId } = discovered.internal;
  if (!teamId) throw new ProbeError("no_accessible_team");
  if (!canceledStateId) throw new ProbeError("no_canceled_workflow_state");

  const suffix = randomUUID().slice(0, 8);
  const resources = {
    groupId: null,
    childId: null,
    templateId: null,
    issueId: null,
    commentIds: [],
    assetUrl: null,
    uploadPersisted: false,
  };
  const observed = {
    issue: { created: false, labelAttached: false, commentReadBack: false },
    labelGroup: { groupCreated: false, childCreated: false, parentBound: false },
    template: { created: false, typeReadBack: false, teamBound: false },
    upload: {
      signedUrlIssued: false,
      returnedHeadersApplied: false,
      bytesUploaded: false,
      putStatus: null,
      embeddedInComment: false,
      fullUploadSkipped: !withUpload,
      deleteClassification: null,
    },
    cleanup: {
      commentsDeleted: false,
      issueCanceled: false,
      uploadDeleted: false,
      templateDeleted: false,
      labelsDeleted: false,
    },
  };
  let failure = null;

  try {
    const group = await createLabel(key, {
      name: `S004 probe group ${suffix}`,
      description: "Temporary Agent Team capability probe",
      color: "#5E6AD2",
      isGroup: true,
      teamId,
    });
    resources.groupId = group.id;
    observed.labelGroup.groupCreated = group.isGroup === true && group.team?.id === teamId;

    const child = await createLabel(key, {
      name: `S004 probe child ${suffix}`,
      description: "Temporary Agent Team capability probe",
      color: "#26B5CE",
      parentId: group.id,
      teamId,
    });
    resources.childId = child.id;
    observed.labelGroup.childCreated = child.isGroup === false;
    observed.labelGroup.parentBound = child.parent?.id === group.id;

    const templateData = await request(
      key,
      `mutation CreateProbeTemplate($input: TemplateCreateInput!) {
        templateCreate(input: $input) {
          success
          template { id type team { id } }
        }
      }`,
      {
        input: {
          type: "issue",
          teamId,
          name: `S004 probe template ${suffix}`,
          description: "Temporary Agent Team capability probe",
          templateData: {
            title: "Agent Team S004 probe",
            description: "Temporary template; safe to delete.",
          },
        },
      },
    );
    if (!templateData.templateCreate.success) {
      throw new ProbeError("template_create_unsuccessful");
    }
    const template = templateData.templateCreate.template;
    resources.templateId = template.id;
    observed.template.created = true;
    observed.template.typeReadBack = template.type === "issue";
    observed.template.teamBound = template.team?.id === teamId;

    const issueData = await request(
      key,
      `mutation CreateProbeIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id } }
      }`,
      {
        input: {
          teamId,
          title: `[S004 probe] Agent Team ${suffix}`,
          description: "Temporary capability probe. This issue will be canceled automatically.",
          labelIds: [child.id],
          useDefaultTemplate: false,
        },
      },
    );
    if (!issueData.issueCreate.success || !issueData.issueCreate.issue?.id) {
      throw new ProbeError("issue_create_unsuccessful");
    }
    resources.issueId = issueData.issueCreate.issue.id;
    observed.issue.created = true;

    const commentData = await request(
      key,
      `mutation CreateProbeComment($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id } }
      }`,
      {
        input: {
          issueId: resources.issueId,
          body: "🤖 Agent Team｜團隊管理者\n\nS004 隔離 Comment round-trip probe。",
          doNotSubscribeToIssue: true,
        },
      },
    );
    if (!commentData.commentCreate.success) throw new ProbeError("comment_create_unsuccessful");
    resources.commentIds.push(commentData.commentCreate.comment.id);

    const file = Buffer.from("agent-team-s004-upload-probe\n", "utf8");
    const uploadData = await request(
      key,
      `mutation RequestProbeUpload($filename: String!, $contentType: String!, $size: Int!) {
        fileUpload(filename: $filename, contentType: $contentType, size: $size, makePublic: false) {
          success
          uploadFile { uploadUrl assetUrl headers { key value } }
        }
      }`,
      { filename: `agent-team-s004-${suffix}.txt`, contentType: "text/plain", size: file.length },
    );
    const upload = uploadData.fileUpload.uploadFile;
    if (!uploadData.fileUpload.success || !upload?.uploadUrl || !upload?.assetUrl) {
      throw new ProbeError("upload_url_unavailable");
    }
    resources.assetUrl = upload.assetUrl;
    observed.upload.signedUrlIssued = true;
    if (withUpload) {
      const uploadHeaders = new Headers({
        "cache-control": "public, max-age=31536000",
        "content-type": "text/plain",
      });
      for (const header of upload.headers) uploadHeaders.set(header.key, header.value);
      observed.upload.returnedHeadersApplied =
        upload.headers.length > 0 &&
        upload.headers.every((header) => uploadHeaders.get(header.key) === header.value);
      const put = await fetchWithTimeout(upload.uploadUrl, {
        method: "PUT",
        headers: uploadHeaders,
        body: file,
      });
      observed.upload.putStatus = put.status;
      if (!put.ok) throw new ProbeError(`upload_put_${put.status}`);
      resources.uploadPersisted = true;
      observed.upload.bytesUploaded = true;

      const evidenceComment = await request(
        key,
        `mutation CreateProbeComment($input: CommentCreateInput!) {
          commentCreate(input: $input) { success comment { id } }
        }`,
        {
          input: {
            issueId: resources.issueId,
            body: `🤖 Agent Team｜團隊管理者\n\nS004 upload probe：[去識別文字證據](${upload.assetUrl})`,
            doNotSubscribeToIssue: true,
          },
        },
      );
      if (!evidenceComment.commentCreate.success) {
        throw new ProbeError("upload_comment_unsuccessful");
      }
      resources.commentIds.push(evidenceComment.commentCreate.comment.id);
      observed.upload.embeddedInComment = true;
    } else {
      observed.upload.deleteClassification = "not_applicable_no_bytes";
    }

    const readBack = await request(
      key,
      `query ReadProbeIssue($id: String!) {
        issue(id: $id) {
          labels(first: 20) { nodes { id parent { id } } }
          comments(first: 20) { nodes { id body } }
        }
      }`,
      { id: resources.issueId },
    );
    observed.issue.labelAttached = readBack.issue.labels.nodes.some(
      (label) => label.id === resources.childId && label.parent?.id === resources.groupId,
    );
    observed.issue.commentReadBack = resources.commentIds.every((id) =>
      readBack.issue.comments.nodes.some((comment) => comment.id === id),
    );
  } catch (error) {
    failure = error instanceof ProbeError ? error.code : "unexpected_error";
  } finally {
    const commentResults = [];
    for (const id of resources.commentIds) {
      try {
        const data = await request(
          key,
          `mutation DeleteProbeComment($id: String!) { commentDelete(id: $id) { success } }`,
          { id },
          { cleanup: true },
        );
        commentResults.push(data.commentDelete.success === true);
      } catch {
        commentResults.push(false);
      }
    }
    observed.cleanup.commentsDeleted =
      resources.commentIds.length > 0 && commentResults.every(Boolean);

    if (resources.issueId) {
      try {
        const data = await request(
          key,
          `mutation CancelProbeIssue($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { success issue { state { type } } }
          }`,
          { id: resources.issueId, input: { stateId: canceledStateId } },
          { cleanup: true },
        );
        observed.cleanup.issueCanceled =
          data.issueUpdate.success === true && data.issueUpdate.issue.state.type === "canceled";
      } catch {
        observed.cleanup.issueCanceled = false;
      }
    }

    if (resources.assetUrl && resources.uploadPersisted) {
      try {
        const data = await request(
          key,
          `mutation DeleteProbeUpload($assetUrl: String!) {
            fileUploadDangerouslyDelete(assetUrl: $assetUrl) { success }
          }`,
          { assetUrl: resources.assetUrl },
          { cleanup: true },
        );
        observed.cleanup.uploadDeleted = data.fileUploadDangerouslyDelete.success === true;
        observed.upload.deleteClassification = observed.cleanup.uploadDeleted
          ? "deleted"
          : "unsuccessful";
      } catch (error) {
        observed.cleanup.uploadDeleted = false;
        observed.upload.deleteClassification =
          error instanceof ProbeError ? error.code : "unexpected_error";
      }
    } else if (resources.assetUrl && withUpload) {
      observed.upload.deleteClassification = "not_applicable_upload_not_persisted";
    }

    if (resources.templateId) {
      try {
        const data = await request(
          key,
          `mutation DeleteProbeTemplate($id: String!) { templateDelete(id: $id) { success } }`,
          { id: resources.templateId },
          { cleanup: true },
        );
        observed.cleanup.templateDeleted = data.templateDelete.success === true;
      } catch {
        observed.cleanup.templateDeleted = false;
      }
    }

    const labelResults = [];
    for (const id of [resources.childId, resources.groupId].filter(Boolean)) {
      try {
        const data = await request(
          key,
          `mutation DeleteProbeLabel($id: String!) { issueLabelDelete(id: $id) { success } }`,
          { id },
          { cleanup: true },
        );
        labelResults.push(data.issueLabelDelete.success === true);
      } catch {
        labelResults.push(false);
      }
    }
    observed.cleanup.labelsDeleted = labelResults.length > 0 && labelResults.every(Boolean);
  }

  const cleanupComplete =
    observed.cleanup.commentsDeleted &&
    observed.cleanup.issueCanceled &&
    observed.cleanup.templateDeleted &&
    observed.cleanup.labelsDeleted &&
    (observed.cleanup.uploadDeleted || !resources.uploadPersisted);
  return {
    success: failure === null && cleanupComplete,
    failure,
    observed,
  };
}

async function main() {
  if (!allowedModes.has(mode)) {
    throw new ProbeError("usage_inventory_or_roundtrip");
  }
  const key = await loadKey();
  const result = mode === "inventory" ? (await inventory(key)).public : await runRoundTrip(key);
  const probeName = mode === "roundtrip" && withUpload ? "roundtrip-with-upload" : mode;
  console.log(JSON.stringify({ schemaVersion: 1, probe: probeName, result }, null, 2));
  if ("success" in result && !result.success) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handleInterrupt = () => {
    interrupted = true;
    activeRequestController?.abort();
  };
  process.once("SIGINT", handleInterrupt);
  process.once("SIGTERM", handleInterrupt);
  try {
    await main();
  } catch (error) {
    const code = error instanceof ProbeError ? error.code : "unexpected_error";
    console.error(
      JSON.stringify({ schemaVersion: 1, probe: sanitizeProbeName(mode), error: code }),
    );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", handleInterrupt);
    process.removeListener("SIGTERM", handleInterrupt);
  }
}
