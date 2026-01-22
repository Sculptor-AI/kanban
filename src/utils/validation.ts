// Input validation utilities

// Username validation
export function validateUsername(username: string): { valid: boolean; error?: string } {
  if (!username || typeof username !== 'string') {
    return { valid: false, error: 'Username is required' };
  }

  const trimmed = username.trim();

  if (trimmed.length < 3) {
    return { valid: false, error: 'Username must be at least 3 characters' };
  }

  if (trimmed.length > 30) {
    return { valid: false, error: 'Username must be at most 30 characters' };
  }

  // Only alphanumeric, underscore, and hyphen
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return { valid: false, error: 'Username can only contain letters, numbers, underscores, and hyphens' };
  }

  return { valid: true };
}

// Password validation
export function validatePassword(password: string): { valid: boolean; error?: string } {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'Password is required' };
  }

  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }

  if (password.length > 128) {
    return { valid: false, error: 'Password must be at most 128 characters' };
  }

  return { valid: true };
}

// Display name validation
export function validateDisplayName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Display name is required' };
  }

  const trimmed = name.trim();

  if (trimmed.length < 1) {
    return { valid: false, error: 'Display name is required' };
  }

  if (trimmed.length > 50) {
    return { valid: false, error: 'Display name must be at most 50 characters' };
  }

  return { valid: true };
}

// Board name validation
export function validateBoardName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Board name is required' };
  }

  const trimmed = name.trim();

  if (trimmed.length < 1) {
    return { valid: false, error: 'Board name is required' };
  }

  if (trimmed.length > 100) {
    return { valid: false, error: 'Board name must be at most 100 characters' };
  }

  return { valid: true };
}

// List name validation
export function validateListName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'List name is required' };
  }

  const trimmed = name.trim();

  if (trimmed.length < 1) {
    return { valid: false, error: 'List name is required' };
  }

  if (trimmed.length > 100) {
    return { valid: false, error: 'List name must be at most 100 characters' };
  }

  return { valid: true };
}

// Card title validation
export function validateCardTitle(title: string): { valid: boolean; error?: string } {
  if (!title || typeof title !== 'string') {
    return { valid: false, error: 'Card title is required' };
  }

  const trimmed = title.trim();

  if (trimmed.length < 1) {
    return { valid: false, error: 'Card title is required' };
  }

  if (trimmed.length > 200) {
    return { valid: false, error: 'Card title must be at most 200 characters' };
  }

  return { valid: true };
}

// Label name validation
export function validateLabelName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Label name is required' };
  }

  const trimmed = name.trim();

  if (trimmed.length < 1) {
    return { valid: false, error: 'Label name is required' };
  }

  if (trimmed.length > 50) {
    return { valid: false, error: 'Label name must be at most 50 characters' };
  }

  return { valid: true };
}

// Color validation (hex color)
export function validateColor(color: string): { valid: boolean; error?: string } {
  if (!color || typeof color !== 'string') {
    return { valid: false, error: 'Color is required' };
  }

  // Accept hex colors with or without #
  const hexPattern = /^#?([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/;
  if (!hexPattern.test(color)) {
    return { valid: false, error: 'Invalid color format' };
  }

  return { valid: true };
}

// Normalize color to include #
export function normalizeColor(color: string): string {
  const trimmed = color.trim();
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

// GitHub URL parsing
export function parseGitHubUrl(url: string): {
  valid: boolean;
  type?: 'issue' | 'pr';
  owner?: string;
  repo?: string;
  number?: number;
  error?: string;
} {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL is required' };
  }

  // Match GitHub issue or PR URLs
  const pattern = /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/(issues|pull)\/(\d+)/i;
  const match = url.match(pattern);

  if (!match) {
    return { valid: false, error: 'Invalid GitHub issue or PR URL' };
  }

  return {
    valid: true,
    type: match[3] === 'pull' ? 'pr' : 'issue',
    owner: match[1],
    repo: match[2],
    number: parseInt(match[4], 10)
  };
}

// Sanitize text content (prevent XSS in stored data)
export function sanitizeText(text: string): string {
  if (!text) return '';
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
