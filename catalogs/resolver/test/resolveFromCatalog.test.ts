import { type WantedDependency, resolveFromCatalog, matchCatalogResolveResult } from '@pnpm/catalogs.resolver'
import { type Catalogs } from '@pnpm/catalogs.types'
import { PnpmError } from '@pnpm/error'

describe('default catalog', () => {
  const catalogs = {
    default: {
      foo: '1.0.0',
    },
  }

  test('resolves using implicit name', () => {
    expect(resolveFromCatalog(catalogs, { alias: 'foo', bareSpecifier: 'catalog:' }))
      .toEqual({ type: 'found', resolution: { catalogName: 'default', specifier: '1.0.0' } })
  })

  test('resolves using explicit name', () => {
    expect(resolveFromCatalog(catalogs, { alias: 'foo', bareSpecifier: 'catalog:default' }))
      .toEqual({ type: 'found', resolution: { catalogName: 'default', specifier: '1.0.0' } })
  })
})

test('resolves named catalog', () => {
  const catalogs = {
    foo: {
      bar: '1.0.0',
    },
  }

  expect(resolveFromCatalog(catalogs, { alias: 'bar', bareSpecifier: 'catalog:foo' }))
    .toEqual({ type: 'found', resolution: { catalogName: 'foo', specifier: '1.0.0' } })
})

test('returns unused for specifier not using catalog protocol', () => {
  const catalogs = {
    foo: {
      bar: '1.0.0',
    },
  }

  expect(resolveFromCatalog(catalogs, { alias: 'bar', bareSpecifier: '^2.0.0' })).toEqual({ type: 'unused' })
})

describe('misconfiguration', () => {
  function resolveFromCatalogOrThrow (catalogs: Catalogs, wantedDependency: WantedDependency) {
    const result = resolveFromCatalog(catalogs, wantedDependency)
    if (result.type === 'misconfiguration') {
      throw result.error
    }
    return result
  }

  test('returns error for missing unresolved catalog', () => {
    const catalogs = {
      foo: {
        bar: '1.0.0',
      },
    }

    expect(() => resolveFromCatalogOrThrow(catalogs, { alias: 'bar', bareSpecifier: 'catalog:' }))
      .toThrow("No catalog entry 'bar' was found for catalog 'default'.")
    expect(() => resolveFromCatalogOrThrow(catalogs, { alias: 'bar', bareSpecifier: 'catalog:baz' }))
      .toThrow("No catalog entry 'bar' was found for catalog 'baz'.")
    expect(() => resolveFromCatalogOrThrow(catalogs, { alias: 'foo', bareSpecifier: 'catalog:foo' }))
      .toThrow("No catalog entry 'foo' was found for catalog 'foo'.")
  })

  test('returns error for recursive catalog', () => {
    const catalogs = {
      foo: {
        bar: 'catalog:foo',
      },
    }

    expect(() => resolveFromCatalogOrThrow(catalogs, { alias: 'bar', bareSpecifier: 'catalog:foo' }))
      .toThrow("Found invalid catalog entry using the catalog protocol recursively. The entry for 'bar' in catalog 'foo' is invalid.")
  })

  test('returns error for workspace protocol in catalog', () => {
    const catalogs = {
      foo: {
        bar: 'workspace:*',
      },
    }

    expect(() => resolveFromCatalogOrThrow(catalogs, { alias: 'bar', bareSpecifier: 'catalog:foo' }))
      .toThrow("The workspace protocol cannot be used as a catalog value. The entry for 'bar' in catalog 'foo' is invalid.")
  })

  test('returns error for file protocol in catalog', () => {
    const catalogs = {
      foo: {
        bar: 'file:./bar.tgz',
      },
    }

    expect(() => resolveFromCatalogOrThrow(catalogs, { alias: 'bar', bareSpecifier: 'catalog:foo' }))
      .toThrow("The entry for 'bar' in catalog 'foo' declares a dependency using the 'file' protocol. This is not yet supported, but may be in a future version of pnpm.")
  })

  test('returns error for link protocol in catalog', () => {
    const catalogs = {
      foo: {
        bar: 'link:./bar',
      },
    }

    expect(() => resolveFromCatalogOrThrow(catalogs, { alias: 'bar', bareSpecifier: 'catalog:foo' }))
      .toThrow("The entry for 'bar' in catalog 'foo' declares a dependency using the 'link' protocol. This is not yet supported, but may be in a future version of pnpm.")
  })
})

describe('matchCatalogResolveResult', () => {
  test('matches found resolution', () => {
    const matcher = {
      found: jest.fn(),
      misconfiguration: jest.fn(),
      unused: jest.fn(),
    }
    const result = { type: 'found', resolution: { catalogName: 'foo', specifier: '1.0.0' } } as const
    matchCatalogResolveResult(result, matcher)

    expect(matcher.found).toHaveBeenCalledWith(result)
    expect(matcher.misconfiguration).not.toHaveBeenCalled()
    expect(matcher.unused).not.toHaveBeenCalled()
  })

  test('matches misconfiguration', () => {
    const matcher = {
      found: jest.fn(),
      misconfiguration: jest.fn(),
      unused: jest.fn(),
    }
    const result = { type: 'misconfiguration', catalogName: 'foo', error: new PnpmError('test', 'info') } as const
    matchCatalogResolveResult(result, matcher)

    expect(matcher.found).not.toHaveBeenCalled()
    expect(matcher.misconfiguration).toHaveBeenCalledWith(result)
    expect(matcher.unused).not.toHaveBeenCalled()
  })

  test('matches unused', () => {
    const matcher = {
      found: jest.fn(),
      misconfiguration: jest.fn(),
      unused: jest.fn(),
    }
    const result = { type: 'unused' } as const
    matchCatalogResolveResult(result, matcher)

    expect(matcher.found).not.toHaveBeenCalled()
    expect(matcher.misconfiguration).not.toHaveBeenCalled()
    expect(matcher.unused).toHaveBeenCalledWith(result)
  })
})
