import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { PermanentError, TransientError } from "../errors.ts";
import { InvoiceFields } from "../pipeline.ts";
import type { ExtractionModel } from "./types.ts";

const TOOL = "record_invoice_fields";

/** Live extractor: forces one tool call whose input schema is generated from the same zod schema the pipeline validates with. */
export class AnthropicExtractor implements ExtractionModel {
  readonly id: string;
  private client: Anthropic;

  constructor(private readonly model = process.env.AGENT_MODEL ?? "claude-sonnet-5-5") {
    this.id = `anthropic:${model}`;
    this.client = new Anthropic(); // reads ANTHROPIC_API_KEY
  }

  async extract(text: string): Promise<unknown> {
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: "Extract invoice fields exactly as written in the document. Leave out any field that is not present. Amounts are integer cents.",
        messages: [{ role: "user", content: text }],
        tools: [{ name: TOOL, description: "Record the fields found in the invoice.", input_schema: z.toJSONSchema(InvoiceFields.partial(), { io: "input" }) as Anthropic.Tool.InputSchema }],
        tool_choice: { type: "tool", name: TOOL },
      });
      const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!call) throw new PermanentError("MODEL_NO_TOOL_CALL", "model did not return the extraction tool call");
      return call.input;
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        const status = e.status ?? 0;
        if (status === 429 || status >= 500 || status === 0) throw new TransientError(`MODEL_HTTP_${status}`, e.message);
        throw new PermanentError(`MODEL_HTTP_${status}`, e.message);
      }
      throw e;
    }
  }
}
