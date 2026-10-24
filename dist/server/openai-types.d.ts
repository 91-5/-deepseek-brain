/**
 * OpenAI 多模态 content 的三种方言。
 *
 * 为什么三种都收：`BerriAI/litellm` 的
 * `litellm/litellm_core_utils/prompt_templates/common_utils.py` 里
 * `_IMAGE_CONTENT_PART_TYPES = frozenset({"image_url", "input_image", "image"})`
 * —— 分别对应 Chat Completions、Responses API、Anthropic 三种客户端写法。
 * 只认一种会让另一类客户端静默退化（图片变垃圾文本），比直接报错更危险。
 *
 * `image_url` 允许是**字符串**而不只是对象：同一个文件里
 * `_image_content_url()` 明确做了 `isinstance(image_url, str)` 分支，
 * 说明线上确实有客户端发裸字符串形态。
 */
export type OpenAIContentPart = {
    type: 'text';
    text: string;
} | {
    type: 'image_url';
    image_url: string | {
        url: string;
        detail?: string;
    };
} | {
    type: 'input_image';
    image_url: string | {
        url: string;
    };
} | {
    type: 'image';
    /** Anthropic 风格：{type:'base64', media_type, data} */
    source?: {
        type: 'base64';
        media_type?: string;
        data?: string;
    };
    image_url?: string;
};
export interface OpenAIChatRequest {
    model: string;
    messages: Array<{
        role: string;
        /**
         * 纯文本请求仍是最常见形态，保持 `string` 可用；
         * 带图请求走 `OpenAIContentPart[]`。
         */
        content: string | OpenAIContentPart[];
        tool_call_id?: string;
        tool_calls?: unknown[];
    }>;
    tools?: Array<{
        type: 'function';
        function: {
            name: string;
            description: string;
            parameters: unknown;
        };
    }>;
    stream?: boolean;
}
export interface OpenAIChatResponse {
    id: string;
    object: 'chat.completion';
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: {
            role: 'assistant';
            content: string;
            tool_calls?: Array<{
                id: string;
                type: 'function';
                function: {
                    name: string;
                    arguments: string;
                };
            }>;
        };
        finish_reason: string | null;
    }>;
    usage?: {
        total_tokens: number;
    };
}
