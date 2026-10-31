// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const stringId = value => value == null ? null : String(value);

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function requireFields(ref, fields) {
  for (const field of fields) {
    if (ref?.[field] == null || ref[field] === '') {
      throw failure('invalid_ref', `Review comment reference requires ${field}`);
    }
  }
}

function normalizeComment(row) {
  const id = stringId(row.id ?? row.github_comment_id);
  const nodeId = row.node_id ?? row.github_comment_node_id ?? null;
  const url = row.html_url ?? row.github_comment_url ?? null;
  const login = row.user?.login ?? row.author_login ?? null;
  return {
    id, node_id: nodeId, html_url: url, user: { login },
    github_comment_id: id, github_comment_node_id: nodeId,
    github_comment_url: url, author_login: login,
    in_reply_to_id: stringId(row.in_reply_to_id),
    path: row.path, line: row.line ?? null, start_line: row.start_line ?? null,
    side: row.side ?? null, start_side: row.start_side ?? null,
    original_line: row.original_line ?? null,
    original_start_line: row.original_start_line ?? null,
    subject_type: row.subject_type ?? null,
    body: row.body, created_at: row.created_at ?? null
  };
}

function updateResult(row) {
  const normalized = normalizeComment(row);
  return {
    github_comment_id: normalized.github_comment_id,
    github_comment_node_id: normalized.github_comment_node_id,
    github_comment_url: normalized.github_comment_url,
    body: normalized.body
  };
}

module.exports = { stringId, failure, requireFields, normalizeComment, updateResult };
