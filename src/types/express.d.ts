// What the middleware attach to the Express request.
declare global {
  namespace Express {
    interface Request {
      /** Set by middleware/requestId - also the X-Request-Id response header and the `requestId` of every error. */
      id: string;
      /** Set by middleware/authenticate from a valid JWT. */
      user?: { userId: number; email: string };
      /** Set by middleware/apiKeyAuth once the x-api-key matched. */
      auth?: { type: 'apiKey' };
      /** Set by middleware/verifyShopifyWebhook: the verified, parsed webhook body. */
      shopifyPayload?: unknown;
    }
  }
}

export {};
