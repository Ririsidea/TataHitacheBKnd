// Fallback categorizer used when Shopify's own product_type is blank (as it is for
// this store's current catalogue). Keyword rules are matched in order against the
// product title, so more specific terms should be listed before general ones.
const RULES = [
  { category: 'Snowboards', pattern: /snowboard/i },
  { category: 'Footwear', pattern: /\b(shoe|shoes|boot|boots|high tops?|sneaker)\b/i },
  { category: 'Bags', pattern: /\bbag\b/i },
  { category: 'Jackets', pattern: /\b(jacket|tuxedo|jumper)\b/i },
  { category: 'Shirts', pattern: /\bshirt\b/i },
  { category: 'Tops & Blouses', pattern: /\b(top|blouse|skirt)\b/i },
  { category: 'Gift Cards', pattern: /gift card/i },
  { category: 'Home & Decor', pattern: /\b(candle stand|painting|decor)\b/i },
  { category: 'Sports & Wellness', pattern: /\b(yoga mat|sleeping mat|ski wax)\b/i },
];

function deriveCategoryFromTitle(title) {
  if (!title) return 'General';
  const match = RULES.find((rule) => rule.pattern.test(title));
  return match ? match.category : 'General';
}

module.exports = { deriveCategoryFromTitle };
