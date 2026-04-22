export interface CloudflareModel {
  id: string;       // e.g. "@cf/meta/llama-3.1-8b-instruct"
  name?: string;
  description?: string;
  task?: {
    id: string;
    name?: string;   // e.g. "Text Generation"
    description?: string;
  };
  properties?: Array<{ property_id: string; value: string }>;
}

interface CloudflareModelsResponse {
  success: boolean;
  result: CloudflareModel[];
  errors: Array<{ message: string }>;
}

export async function fetchCloudflareModels(
  accountId: string,
  apiKey: string,
  filter: string = 'text-generation'
): Promise<CloudflareModel[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=100`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });
  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`Cloudflare API request failed (${response.status}): ${raw}`);
  }

  let json: CloudflareModelsResponse;
  try {
    json = JSON.parse(raw) as CloudflareModelsResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`Failed to parse Cloudflare models response (${message}): ${raw}`);
  }

  if (!json.success) {
    const errMsg = json.errors?.map(e => e.message).join(', ') ?? 'Unknown error';
    throw new Error(`Cloudflare API error: ${errMsg}`);
  }

  if (filter === 'all') {
    return json.result;
  }

  return json.result.filter(m =>
    m.task?.id === filter
  );
}
