// Rating bounds live here rather than in courseRatingService so that client
// components can import them without pulling the database driver into the
// browser bundle.

export const MIN_RATING = 1;
export const MAX_RATING = 5;
