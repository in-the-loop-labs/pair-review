/**
 * Path normalization utilities for consistent path comparison
 */

/**
 * Normalize a file path for consistent comparison
 *
 * This function:
 * - Removes leading/trailing whitespace
 * - Removes leading './' prefix (handles repeated patterns like '././')
 * - Removes leading '/' prefix (handles repeated patterns like '//')
 * - Handles interleaved patterns like '/./src' by iterating
 * - Normalizes multiple consecutive slashes to single slash
 * - Does NOT modify case (paths are case-sensitive on most systems)
 *
 * @param {string} filePath - The file path to normalize
 * @returns {string} Normalized path
 *
 * @example
 * normalizePath('./src/foo.js')    // => 'src/foo.js'
 * normalizePath('/src/foo.js')     // => 'src/foo.js'
 * normalizePath('src//foo.js')     // => 'src/foo.js'
 * normalizePath('  src/foo.js  ')  // => 'src/foo.js'
 * normalizePath('././src/foo.js')  // => 'src/foo.js'
 * normalizePath('//./src/foo.js')  // => 'src/foo.js'
 * normalizePath(null)              // => ''
 * normalizePath(undefined)         // => ''
 */
function normalizePath(filePath) {
  // Handle null, undefined, and non-string inputs
  if (filePath == null || typeof filePath !== 'string') {
    return '';
  }

  let result = filePath;

  // Trim whitespace
  result = result.trim();

  // Return early if empty after trimming
  if (result === '') {
    return '';
  }

  // Collapse multiple consecutive slashes into single slashes
  // Do this before removing leading slashes to handle cases like '//src/foo.js'
  result = result.replace(/\/+/g, '/');

  // Remove leading './' and '/' iteratively
  // This handles cases like '/./src/foo.js' which need both removed
  let prevLength;
  do {
    prevLength = result.length;

    // Remove leading './'
    while (result.startsWith('./')) {
      result = result.slice(2);
    }

    // Remove leading '/'
    while (result.startsWith('/')) {
      result = result.slice(1);
    }
  } while (result.length !== prevLength);

  return result;
}

/**
 * Check if two paths are equivalent after normalization
 *
 * @param {string} path1 - First path to compare
 * @param {string} path2 - Second path to compare
 * @returns {boolean} True if paths are equivalent
 */
function pathsEqual(path1, path2) {
  return normalizePath(path1) === normalizePath(path2);
}

/**
 * Check if a path exists in a list of paths (using normalized comparison)
 *
 * @deprecated Use pathExistsInSet() with a pre-normalized Set for O(1) lookups
 * @param {string} needle - Path to search for
 * @param {Array<string>} haystack - Array of paths to search in
 * @returns {boolean} True if path exists in the array
 */
function pathExistsInList(needle, haystack) {
  if (!needle || !Array.isArray(haystack)) {
    return false;
  }

  const normalizedNeedle = normalizePath(needle);
  return haystack.some(path => normalizePath(path) === normalizedNeedle);
}

/**
 * Check if a path exists in a Set of pre-normalized paths (O(1) lookup)
 *
 * This is the preferred method for checking path existence when performing
 * multiple lookups against the same set of valid paths.
 *
 * @param {string} needle - Path to search for (will be normalized)
 * @param {Set<string>} normalizedPathsSet - Set of pre-normalized paths
 * @returns {boolean} True if path exists in the Set
 *
 * @example
 * // Pre-normalize paths once
 * const validPathsSet = new Set(validPaths.map(p => normalizePath(p)));
 * // Then use O(1) lookups
 * pathExistsInSet('./src/foo.js', validPathsSet) // => true
 */
function pathExistsInSet(needle, normalizedPathsSet) {
  if (!needle || !(normalizedPathsSet instanceof Set)) {
    return false;
  }

  const normalizedNeedle = normalizePath(needle);
  return normalizedPathsSet.has(normalizedNeedle);
}

/**
 * Normalize a GitHub repository identifier for case-insensitive matching.
 *
 * GitHub repository names and owner names are case-insensitive. URLs like
 * github.com/Owner/Repo and github.com/owner/repo refer to the same repository.
 * This function normalizes repository identifiers to lowercase to ensure
 * consistent database lookups regardless of URL casing.
 *
 * @param {string} owner - Repository owner (GitHub username or org)
 * @param {string} repo - Repository name
 * @returns {string} Normalized repository identifier in "owner/repo" format (lowercase)
 *
 * @example
 * normalizeRepository('Owner', 'Repo')     // => 'owner/repo'
 * normalizeRepository('OWNER', 'REPO')     // => 'owner/repo'
 * normalizeRepository('owner', 'repo')     // => 'owner/repo'
 */
function normalizeRepository(owner, repo) {
  if (!owner || typeof owner !== 'string' || !repo || typeof repo !== 'string') {
    throw new Error('owner and repo must be non-empty strings');
  }

  const trimmedOwner = owner.trim();
  const trimmedRepo = repo.trim();

  if (!trimmedOwner || !trimmedRepo) {
    throw new Error('owner and repo must be non-empty strings');
  }

  return `${trimmedOwner.toLowerCase()}/${trimmedRepo.toLowerCase()}`;
}

module.exports = {
  normalizePath,
  pathsEqual,
  pathExistsInList,
  pathExistsInSet,
  normalizeRepository
};
