import fetch from 'node-fetch';

export default async function(query: string) {
  const res = await fetch(
    'https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `bearer ${process.env.GH_TOKEN}`,
      },
      body: JSON.stringify({ query }).replace(/\\n/g, ''),
    }
  );

  if (!res.ok) throw new Error(`GitHub GraphQL request failed (HTTP ${res.status})`);

  const result = await res.json();
  if (result.errors?.length) {
    throw new Error(result.errors.map(error => error.message).join('; '));
  }
  return result;
}
