import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ArgusModePanel } from '../../../src/components/views/board-view/argus-mode-panel';
import type { ArgusModeState } from '@automaker/types';
const client = vi.hoisted(() => ({
  state: vi.fn(),
  list: vi.fn(),
  select: vi.fn(),
  plan: vi.fn(),
  run: vi.fn(),
  get: vi.fn(),
  approveTask: vi.fn(),
}));
vi.mock('../../../src/lib/http-api-client', () => ({
  getHttpApiClient: () => ({ argusModes: client }),
}));
const config = {
  capabilities: { repositoryRead: false, referenceImplementation: false, llmJudge: false },
  permissions: { repositoryChanges: false, modelCalls: false },
  evaluation: { minimumScore: 1, requireJudge: false },
};
const state: ArgusModeState = {
  version: 1,
  revision: 1,
  activeMode: 'default',
  configurationRevision: 1,
  configs: { default: config, rea: config, paper2code: config, eval: config },
  runs: [],
  history: [],
};
beforeEach(() => {
  client.state.mockResolvedValue(structuredClone(state));
  client.list.mockResolvedValue({
    modes: ['default', 'rea', 'paper2code', 'eval'].map((id) => ({
      id,
      label: id === 'default' ? 'Default' : id,
      description: `${id} workflow`,
      adapterVersion: 'v1',
    })),
  });
  client.select.mockImplementation(async (_project, mode) => ({
    ...structuredClone(state),
    activeMode: mode,
    revision: 2,
  }));
});
describe('Argus mode controls', () => {
  it('selects a mode without executing a plan or approving a campaign', async () => {
    render(<ArgusModePanel projectPath="/registered/project" />);
    const selector = await screen.findByLabelText('Argus operating mode');
    fireEvent.change(selector, { target: { value: 'rea' } });
    await waitFor(() =>
      expect(client.select).toHaveBeenCalledWith('/registered/project', 'rea', 1)
    );
    expect(client.plan).not.toHaveBeenCalled();
    expect(client.run).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        'Mode selection does not start a campaign. Plan first, then run explicitly.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run plan' })).toBeDisabled();
  });
  it('requires an explicit run action after planning and renders evidence as escaped text', async () => {
    const run = {
      id: 'r1',
      mode: 'default',
      config,
      status: 'planned',
      sourceSha: 'a'.repeat(40),
      steps: ['Plan task'],
      tasks: [],
      artifacts: [],
      evaluation: null,
    };
    client.plan.mockResolvedValue(run);
    client.run.mockResolvedValue({
      ...run,
      status: 'completed',
      evaluation: { verdict: 'PASS', reasons: [] },
      artifacts: [
        {
          name: 'report.md',
          sha256: 'b'.repeat(64),
          content: '<script>untrusted document</script>',
        },
      ],
    });
    render(<ArgusModePanel projectPath="/registered/project" />);
    await screen.findByLabelText('Argus operating mode');
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run plan' })).toBeEnabled());
    expect(client.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Run plan' }));
    await waitFor(() =>
      expect(client.run).toHaveBeenCalledWith('/registered/project', 'r1', undefined)
    );
    expect(await screen.findByText('<script>untrusted document</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });
});
