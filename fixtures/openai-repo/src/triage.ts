import { Configuration, OpenAIApi } from 'openai';

/**
 * The client, built once. `Configuration` and `OpenAIApi` are both gone in
 * openai 4 — the package exports a default class instead — so this import is
 * the first thing an upgrade breaks.
 */
const configuration = new Configuration({ apiKey: process.env['OPENAI_API_KEY'] });
const client = new OpenAIApi(configuration);

export interface Ticket {
  id: string;
  subject: string;
  body: string;
}

/**
 * Ask the model which queue a support ticket belongs in.
 *
 * Never called from the tests — it would need a key and a network. It exists to
 * be typechecked, which is where the upgrade bites.
 */
export async function routeTicket(ticket: Ticket): Promise<string> {
  const completion = await client.createChatCompletion({
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: 'Reply with one of: billing, technical, other.' },
      { role: 'user', content: `${ticket.subject}\n\n${ticket.body}` },
    ],
    temperature: 0,
  });
  return completion.data.choices[0]?.message?.content?.trim() ?? 'other';
}
