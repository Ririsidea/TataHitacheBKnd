// Builders for raw Shopify productVariants nodes (what shopify.listProductsCatalog returns).
const gid = (type, id) => `gid://shopify/${type}/${id}`;

function variantNode({
  productId,
  variantId,
  sku,
  title = 'Default Title',
  options = [{ name: 'Title', value: 'Default Title' }],
  price = '100.00',
  compareAtPrice = null,
  qty = 5,
  product = {},
}) {
  return {
    id: gid('ProductVariant', variantId),
    sku,
    title,
    price,
    compareAtPrice,
    inventoryQuantity: qty,
    selectedOptions: options,
    product: {
      id: gid('Product', productId),
      title: 'Product',
      handle: 'product',
      vendor: 'THCM',
      productType: 'Gear',
      tags: [],
      status: 'ACTIVE',
      createdAt: '2026-01-01T00:00:00Z',
      featuredImage: { url: 'https://cdn.test/p.png' },
      ...product,
    },
  };
}

// A small realistic catalog: a helmet in 4 variants, gloves, a vest and a custom-typed product.
function sampleCatalog() {
  const helmet = { title: 'Safety Helmet', handle: 'safety-helmet', productType: 'Helmets', vendor: 'Acme', tags: ['ppe', 'head'], createdAt: '2026-03-01T00:00:00Z' };
  const opts = (size, color) => [{ name: 'Size', value: size }, { name: 'Color', value: color }];
  return [
    variantNode({ productId: 1001, variantId: 2001, sku: 'HEL-M-BLK', title: 'M / Black', options: opts('M', 'Black'), price: '499.00', compareAtPrice: '599.00', qty: 10, product: helmet }),
    variantNode({ productId: 1001, variantId: 2002, sku: 'HEL-L-BLK', title: 'L / Black', options: opts('L', 'Black'), price: '519.00', qty: 0, product: helmet }),
    variantNode({ productId: 1001, variantId: 2003, sku: 'HEL-M-YEL', title: 'M / Yellow', options: opts('M', 'Yellow'), price: '499.00', qty: 3, product: helmet }),
    variantNode({ productId: 1001, variantId: 2004, sku: 'HEL-L-YEL', title: 'L / Yellow', options: opts('L', 'Yellow'), price: '519.00', qty: 7, product: helmet }),
    variantNode({
      productId: 1002, variantId: 2005, sku: 'GLV-100', price: '150.00', qty: 40,
      product: { title: 'Work Gloves', handle: 'work-gloves', productType: 'Hand Protection', vendor: 'Grip Co', tags: ['ppe', 'hands'], createdAt: '2026-02-01T00:00:00Z' },
    }),
    variantNode({
      productId: 1003, variantId: 2006, sku: 'VST-9', price: '300.00', qty: 2,
      product: { title: 'Hi-Vis Vest', handle: 'hi-vis-vest', productType: 'Apparel', vendor: 'Acme', tags: ['visibility'], createdAt: '2026-04-01T00:00:00Z' },
    }),
    variantNode({
      productId: 1004, variantId: 2007, sku: 'MUG-1', price: '80.00', qty: 100,
      product: { title: 'Helmet Mug', handle: 'helmet-mug', productType: 'Merch', vendor: 'THCM', tags: ['gift'], createdAt: '2025-12-01T00:00:00Z', status: 'DRAFT' },
    }),
  ];
}

module.exports = { gid, variantNode, sampleCatalog };
