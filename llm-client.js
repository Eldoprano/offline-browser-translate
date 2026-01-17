/**
 * Unified LLM Client for Ollama and LMStudio
 */

import { buildPrompt, formatTextsForPrompt, parseTranslationResponse, PROMPT_TEMPLATES, getLanguageName } from './utils.js';

export class LLMClient {
    constructor(settings) {
        this.settings = settings;
    }

    /**
     * Get list of available models from the current provider
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async listModels() {
        const provider = this.settings.provider;

        if (provider === 'ollama' || provider === 'auto') {
            try {
                const models = await this.listOllamaModels();
                if (models.length > 0) return models;
            } catch (e) {
                if (provider === 'ollama') throw e;
            }
        }

        if (provider === 'lmstudio' || provider === 'auto') {
            try {
                const models = await this.listLMStudioModels();
                if (models.length > 0) return models;
            } catch (e) {
                if (provider === 'lmstudio') throw e;
            }
        }

        return [];
    }

    async listOllamaModels() {
        const response = await fetch(`${this.settings.ollamaUrl}/api/tags`);
        if (!response.ok) throw new Error('Failed to fetch Ollama models');

        const data = await response.json();
        return (data.models || []).map(m => ({
            id: m.name,
            name: m.name,
            provider: 'ollama'
        }));
    }

    async listLMStudioModels() {
        const response = await fetch(`${this.settings.lmstudioUrl}/v1/models`);
        if (!response.ok) throw new Error('Failed to fetch LMStudio models');

        const data = await response.json();
        return (data.data || []).map(m => ({
            id: m.id,
            name: m.id,
            provider: 'lmstudio'
        }));
    }

    /**
     * Detect which provider a model belongs to
     * @param {string} modelId 
     * @returns {Promise<'ollama'|'lmstudio'|null>}
     */
    async detectModelProvider(modelId) {
        try {
            const ollamaModels = await this.listOllamaModels();
            if (ollamaModels.some(m => m.id === modelId)) return 'ollama';
        } catch (e) { }

        try {
            const lmstudioModels = await this.listLMStudioModels();
            if (lmstudioModels.some(m => m.id === modelId)) return 'lmstudio';
        } catch (e) { }

        return null;
    }

    /**
     * Translate a batch of texts
     * @param {Array<{id: number, text: string}>} textItems 
     * @param {string} targetLanguage 
     * @returns {Promise<Array<{id: number, text: string}>>}
     */
    async translate(textItems, targetLanguage) {
        const modelId = this.settings.selectedModel;
        if (!modelId) throw new Error('No model selected');

        // Detect provider if auto
        let provider = this.settings.provider;
        if (provider === 'auto') {
            provider = await this.detectModelProvider(modelId);
            if (!provider) throw new Error('Could not detect model provider');
        }

        // Get prompt template
        const templateKey = this.settings.requestFormat || 'default';
        const template = PROMPT_TEMPLATES[templateKey] || PROMPT_TEMPLATES.default;

        // Use custom prompts if advanced mode is enabled
        let systemPrompt = template.system;
        let userPromptTemplate = template.user;

        if (this.settings.useAdvanced) {
            if (this.settings.customSystemPrompt) {
                systemPrompt = this.settings.customSystemPrompt;
            }
            if (this.settings.customUserPromptTemplate) {
                userPromptTemplate = this.settings.customUserPromptTemplate;
            }
        }

        // Build the user prompt
        const textsFormatted = formatTextsForPrompt(textItems);
        const userPrompt = buildPrompt(userPromptTemplate, {
            targetLanguage: getLanguageName(targetLanguage),
            texts: textsFormatted
        });

        // Build system prompt
        const finalSystemPrompt = buildPrompt(systemPrompt, {
            targetLanguage: getLanguageName(targetLanguage)
        });

        // Call the appropriate provider
        let response;
        if (provider === 'ollama') {
            response = await this.callOllama(modelId, finalSystemPrompt, userPrompt);
        } else {
            response = await this.callLMStudio(modelId, finalSystemPrompt, userPrompt);
        }

        // Parse response
        return parseTranslationResponse(response, textItems.length);
    }

    async callOllama(modelId, systemPrompt, userPrompt) {
        const body = {
            model: modelId,
            stream: false
        };

        // Use structured output if enabled
        if (this.settings.useStructuredOutput) {
            body.format = 'json';
        }

        // Combine prompts for Ollama's generate API
        body.prompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;

        if (this.settings.temperature !== undefined) {
            body.options = { temperature: this.settings.temperature };
        }

        const response = await fetch(`${this.settings.ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Ollama error: ${error}`);
        }

        const data = await response.json();
        return data.response;
    }

    async callLMStudio(modelId, systemPrompt, userPrompt) {
        const messages = [];

        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: userPrompt });

        const body = {
            model: modelId,
            messages,
            temperature: this.settings.temperature || 0.3,
            stream: false
        };

        // Use structured output if enabled (OpenAI-compatible format)
        if (this.settings.useStructuredOutput) {
            body.response_format = { type: 'json_object' };
        }

        const response = await fetch(`${this.settings.lmstudioUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`LMStudio error: ${error}`);
        }

        const data = await response.json();
        return data.choices[0]?.message?.content || '';
    }
}

export default LLMClient;
