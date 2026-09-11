// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .simona/ folder
export const SIMONA_FOLDER_PERMISSION_PATTERN = '/.simona/**'

// Permission pattern for granting session-level access to the global ~/.simona/ folder
export const GLOBAL_SIMONA_FOLDER_PERMISSION_PATTERN = '~/.simona/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
