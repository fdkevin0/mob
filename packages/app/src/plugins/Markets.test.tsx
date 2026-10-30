import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { SkillsPlugin } from './SkillsPlugin';
import { MCPPlugin } from './MCPPlugin';

vi.mock('../api', () => ({ api: vi.fn() }));
const connection = { url: 'http://localhost:8787', token: 'test' };
beforeEach(() => { vi.mocked(api).mockReset(); });

it('shows shared skills and update failures without offering to delete them', async () => {
  vi.mocked(api).mockResolvedValue({ skills: [{ name: 'shared', description: 'Shared instructions', managed: false, update: { status: 'error', message: 'GitHub returned 403' } }], warnings: [] });
  render(<SkillsPlugin connection={connection} />);
  expect(await screen.findByText('Externally managed')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith(connection, '/plugins/skills/check', {}));
  expect(await screen.findByText('GitHub returned 403')).toBeTruthy();
});

it('installs only the previewed revision and then refreshes installed skills', async () => {
  const commit = 'a'.repeat(40);
  vi.mocked(api).mockImplementation(async (_connection, path) => {
    if (path.endsWith('/preview')) return { source: 'anthropics/skills', skillPath: 'skills/frontend-design/SKILL.md', commit, name: 'frontend-design', description: 'Design', content: 'Reviewed instructions', files: ['SKILL.md'], executableFiles: [], folderHash: 'b'.repeat(40) };
    return { skills: [], warnings: [] };
  });
  render(<SkillsPlugin connection={connection} />);
  fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Preview' })[0]!);
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Reviewed instructions')).toBeTruthy();
  expect(vi.mocked(api).mock.calls.some(call => call[1].endsWith('/install'))).toBe(false);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Install skill' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith(connection, '/plugins/skills/install', { source: 'anthropics/skills', skillPath: 'skills/frontend-design/SKILL.md', ref: undefined, commit }));
  expect(await screen.findByText('Skill installed. Available from the next turn.')).toBeTruthy();
});

it('keeps a failed installation review open for recovery', async () => {
  vi.mocked(api).mockImplementation(async (_connection, path) => {
    if (path.endsWith('/preview')) return { source: 'anthropics/skills', skillPath: 'skills/frontend-design/SKILL.md', commit: 'a'.repeat(40), name: 'frontend-design', content: 'Instructions', files: ['SKILL.md'] };
    if (path.endsWith('/install')) throw new Error('GitHub returned 500');
    return { skills: [], warnings: [] };
  });
  render(<SkillsPlugin connection={connection} />);
  fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Preview' })[0]!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Install skill' }));
  expect(await within(dialog).findByText('GitHub returned 500')).toBeTruthy();
  expect((within(dialog).getByRole('button', { name: 'Install skill' }) as HTMLButtonElement).disabled).toBe(false);
});

it('separates MCP installation from connection and preserves configured servers', async () => {
  vi.mocked(api).mockResolvedValue({ servers: [
    { name: 'configured', managed: false, connected: true, status: '2 tools', tools: [] },
    { name: 'remote', managed: true, connected: false, status: 'Sign in to connect', signInUrl: 'https://example.com/authorize', tools: [] },
  ], catalog: [] });
  render(<MCPPlugin connection={connection} />);
  expect(await screen.findByText('Managed by config.yaml')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Remove installation' })).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'Sign in to connect' }).getAttribute('href')).toBe('https://example.com/authorize');
  expect(screen.getByText('Connected')).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Finish sign-in from another device/), { target: { value: 'http://localhost/callback?code=x' } });
  fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith(connection, '/plugins/mcp/signin', { address: 'http://localhost/callback?code=x' }));
});

it('requires a review before MCP installation and blocks entries needing headers', async () => {
  vi.mocked(api).mockResolvedValue({ servers: [], catalog: [{ name: 'keyed', description: 'Needs credentials', url: 'https://example.com/mcp', source: 'registry', requiredHeader: 'X-Key' }] });
  render(<MCPPlugin connection={connection} />);
  await screen.findByText('No servers installed. Open Discover to connect one.');
  fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
  fireEvent.click(screen.getByRole('button', { name: 'View details' }));
  const dialog = await screen.findByRole('dialog');
  expect((within(dialog).getByRole('button', { name: 'Install server' }) as HTMLButtonElement).disabled).toBe(true);
  expect(vi.mocked(api).mock.calls.some(call => call[1].endsWith('/install'))).toBe(false);
});
