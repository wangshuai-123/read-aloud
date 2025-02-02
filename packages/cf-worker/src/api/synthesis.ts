import { z, OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { Service, FORMAT_CONTENT_TYPE } from "../utils/synthesis";
import retry, { RetryError } from "../utils/retry";
import buildSsml from "../utils/buildSsml";

type Bindings = {
  TOKEN: string;
};
const synthesis = new OpenAPIHono<{ Bindings: Bindings }>();
export default synthesis;

// 解密函数
function decrypt(input: string): string {
    if (!input || input.length < 2) {
        return ""; // 或者你可以抛出一个错误，取决于你的需求
    }
    const encryptedString = input.substring(1, input.length - 1);
    return encryptedString.replace(/./g, function(c) {
        return String.fromCharCode(c.charCodeAt(0) - 49);
    });
}

// 验证时间函数
function validateTimes(time: string): boolean {
  return /^\d{13}$/.test(time);
}

const querySchema = z.object({
  voiceName: z
    .string()
    .optional()
    .openapi({
      param: { description: "语音名称" },
      example: "zh-CN-XiaoxiaoNeural",
    }),
  pitch: z
    .string()
    .optional()
    .openapi({
      param: { description: "音高" },
      examples: ["-50%", "-50Hz", "low"],
    }),
  rate: z
    .string()
    .optional()
    .openapi({ param: { description: "语速" } }),
  volume: z
    .string()
    .optional()
    .openapi({ param: { description: "音量" } }),
  format: z
    .string()
    .optional()
    .openapi({ param: { description: "音频格式" } }),
  token: z
    .string()
    .optional()
    .openapi({ param: { description: "Token" } }),
  text: z.string().openapi({ param: { description: "合成文本" } }),
  // 修改 voice 参数，使用 refine 进行复杂验证
  voice: z.string().openapi({ param: { description: "voice" } }).refine((value) => {
    if (!value) return false;
    const decryptedVoice = decrypt(value);
    if (!validateTimes(decryptedVoice)) {
      return false;
    }

    const timestamp = parseInt(decryptedVoice, 10);
    const currentTime = Date.now();
    return currentTime - timestamp <= 6 * 60 * 60 * 1000;
  }, { message: "无效的语音参数" }),
});

const route = createRoute({
  method: "get",
  path: "/",
  request: { query: querySchema },
  responses: {
    200: { description: "返回音频" },
    401: { description: "Unauthorized" },
    404: { description: "Not Found" },
    500: { description: "Error" },
  },
});

synthesis.openapi(route, async (c) => {
  const {
    voiceName = "zh-CN-XiaoxiaoNeural",
    rate,
    pitch,
    text = "",
    format = "audio-24khz-48kbitrate-mono-mp3",
    volume,
    token,
    voice,
  } = c.req.valid("query");

  function getToken() {
    if (
      typeof globalThis.process !== "undefined" &&
      globalThis.process.env.TOKEN !== undefined
    ) {
      return globalThis.process.env.TOKEN;
    }
    if (c.env.TOKEN !== undefined && c.env.TOKEN !== "") {
      return c.env.TOKEN;
    }
    return "";
  }

  const systemToken = getToken();

  if (systemToken !== "") {
    if (token !== systemToken) {
      c.status(401);
      return c.text("Unauthorized");
    }
  }

  const service = new Service();

  if (!FORMAT_CONTENT_TYPE.has(format)) {
    throw new HTTPException(400, { message: `无效的音频格式：${format}` });
  }

  const ssml = buildSsml(text, { voiceName, pitch, rate, volume });
  DEBUG && console.debug("SSML:", ssml);
  try {
    const result = await retry(
      async () => {
        const result = await service.convert(ssml, format as string);
        return result;
      },
      3,
      (index, error, abort) => {
        console.warn(`Attempt ${index} failed：${error}`);
        if (
          error instanceof Error &&
          error.message.includes("SSML is invalid")
        ) {
          abort();
          throw new HTTPException(400, { message: "SSML 无效" });
        }
      },
    );
    c.header("Content-Type", FORMAT_CONTENT_TYPE.get(format));
    return c.body(result);
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    c.status(500);
    if (!(error instanceof RetryError))
      throw new HTTPException(500, {
        message: `UnknownError: ${(error as string).toString()}`,
      });
    throw new HTTPException(500, {
      message: `${error.message}. Cause: ${error.cause
        .map((e) => (e as Error).toString())
        .join(", ")}`,
    });
  }
});