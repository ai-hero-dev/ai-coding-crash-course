// Comment bounds live here rather than in commentService so that client
// components can import them without pulling the database driver into the
// browser bundle.

export const MIN_COMMENT_LENGTH = 1;
export const MAX_COMMENT_LENGTH = 5000;
