export interface JulesSource {
  name: string;
  id?: string;
  githubRepo?: { owner: string; repo: string };
}
export interface JulesPullRequest {
  url: string;
  title?: string;
  description?: string;
}
export interface JulesSession {
  name: string;
  id: string;
  state: string;
  title?: string;
  sourceContext?: { source?: string };
  url?: string;
  outputs?: Array<{ pullRequest?: JulesPullRequest }>;
}
export interface JulesActivity {
  name?: string;
  type?: string;
  description?: string;
  message?: string;
  createTime?: string;
}
export class JulesError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable: boolean,
    public blocked = false
  ) {
    super(message);
  }
}
export function normalizeGitHubRepository(url: string): string | null {
  const match = url
    .trim()
    .match(
      /^(?:git@github\.com:|https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/]+)\/([^/#]+?)(?:\.git)?$/i
    );
  return match ? `${match[1]}/${match[2].replace(/\.git$/i, '')}`.toLowerCase() : null;
}

export class JulesClient {
  constructor(
    private apiKey: string | undefined,
    private fetcher: typeof fetch = fetch,
    private baseUrl = 'https://jules.googleapis.com/v1alpha',
    private options: {
      timeoutMs?: number;
      maxRetries?: number;
      maxPages?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {}
  ) {}
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.apiKey)
      throw new JulesError('JULES_AUTH_FAILED', 'JULES_API_KEY is not configured', false, true);
    const sleep =
      this.options.sleep || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const max = this.options.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
      try {
        const response = await this.fetcher(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': this.apiKey,
            ...init.headers,
          },
        });
        if (response.ok) {
          if (response.status === 204) return undefined as T;
          const text = await response.text();
          return (text ? JSON.parse(text) : {}) as T;
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= max)
          throw new JulesError(
            response.status === 401 || response.status === 403
              ? 'JULES_AUTH_FAILED'
              : 'JULES_REMOTE_FAILED',
            `Jules API returned HTTP ${response.status}`,
            retryable
          );
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(
          retryAfter > 0
            ? retryAfter * 1000
            : Math.min(500 * 2 ** attempt + Math.random() * 250, 10_000)
        );
      } catch (error) {
        if (error instanceof JulesError) throw error;
        if (attempt >= max)
          throw new JulesError(
            'JULES_SESSION_TIMEOUT',
            error instanceof Error ? error.name : 'request failed',
            true
          );
        await sleep(Math.min(500 * 2 ** attempt, 10_000));
      } finally {
        clearTimeout(timer);
      }
    }
  }
  private async paginate<T>(path: string, key: 'sources' | 'sessions'): Promise<T[]> {
    const all: T[] = [];
    let token = '';
    for (let page = 0; page < (this.options.maxPages ?? 20); page++) {
      const result = await this.request<Record<string, unknown>>(
        `${path}?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`
      );
      all.push(...((result[key] as T[]) || []));
      token = String(result.nextPageToken || '');
      if (!token) return all;
    }
    throw new JulesError('JULES_PAGINATION_LIMIT', 'Jules pagination limit reached', false);
  }
  listSources() {
    return this.paginate<JulesSource>('/sources', 'sources');
  }
  listSessions() {
    return this.paginate<JulesSession>('/sessions', 'sessions');
  }
  async findRepositorySource(repository: string) {
    const exact = (await this.listSources()).filter(
      (source) =>
        source.githubRepo &&
        `${source.githubRepo.owner}/${source.githubRepo.repo}`.toLowerCase() ===
          repository.toLowerCase()
    );
    if (exact.length !== 1)
      throw new JulesError(
        'JULES_SOURCE_NOT_FOUND',
        exact.length
          ? `Multiple exact Jules sources found for ${repository}`
          : `No Jules source found for ${repository}`,
        false,
        true
      );
    return exact[0];
  }
  createTaskSession(input: {
    prompt: string;
    title: string;
    source: string;
    branch: string;
    requirePlanApproval?: boolean;
  }) {
    return this.request<JulesSession>('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        prompt: input.prompt,
        title: input.title,
        sourceContext: {
          source: input.source,
          githubRepoContext: { startingBranch: input.branch },
        },
        requirePlanApproval: input.requirePlanApproval ?? false,
        automationMode: 'AUTO_CREATE_PR',
      }),
    });
  }
  getSession(id: string) {
    return this.request<JulesSession>(`/sessions/${encodeURIComponent(id)}`);
  }
  async listActivities(id: string) {
    return (
      (
        await this.request<{ activities?: JulesActivity[] }>(
          `/sessions/${encodeURIComponent(id)}/activities?pageSize=100`
        )
      ).activities || []
    );
  }
  sendMessage(id: string, prompt: string) {
    return this.request<void>(`/sessions/${encodeURIComponent(id)}:sendMessage`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    });
  }
  deleteSession(id: string) {
    return this.request<void>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  async reconcileSession(id: string) {
    const session = await this.getSession(id);
    return {
      session,
      activities: await this.listActivities(id),
      pullRequest: this.extractPullRequest(session),
    };
  }
  extractPullRequest(session: JulesSession): JulesPullRequest | null {
    return session.outputs?.map((output) => output.pullRequest).find(Boolean) || null;
  }
}
export function normalizeJulesActivity(activity: JulesActivity): string {
  const raw =
    `${activity.type || ''} ${activity.description || activity.message || ''}`.toLowerCase();
  if (raw.includes('pull request')) return 'JULES_PR_CREATED';
  if (raw.includes('commit')) return 'JULES_COMMIT';
  if (raw.includes('plan')) return 'JULES_PLANNING';
  return 'JULES_WORKING';
}
