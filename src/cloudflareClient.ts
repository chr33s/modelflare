import * as https from 'https';

export interface CloudflareModel {
  id: string;       // e.g. "@cf/meta/llama-3.1-8b-instruct"
  name: string;
  description: string;
  task: {
    id: string;
    name: string;   // e.g. "Text Generation"
    description: string;
  };
  properties: Array<{ property_id: string; value: string }>;
}

interface CloudflareModelsResponse {
  success: boolean;
  result: CloudflareModel[];
  errors: Array<{ message: string }>;
}

function httpsGet(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

export async function fetchCloudflareModels(
  accountId: string,
  apiKey: string,
  filter: string = 'text-generation'
): Promise<CloudflareModel[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=100`;

  const raw = await httpsGet(url, {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  });

  const json: CloudflareModelsResponse = JSON.parse(raw);

  if (!json.success) {
    const errMsg = json.errors?.map(e => e.message).join(', ') ?? 'Unknown error';
    throw new Error(`Cloudflare API error: ${errMsg}`);
  }

  if (filter === 'all') {
    return json.result;
  }

  return json.result.filter(m =>
    m.task?.name?.toLowerCase().replace(/\s+/g, '-') === filter
  );
}
