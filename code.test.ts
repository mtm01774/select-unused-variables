// Mock Jest globals since we can't import them
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: any;
declare const beforeEach: (fn: () => void) => void;

// Add jest namespace declaration
declare namespace jest {
  function clearAllMocks(): void;
  function fn(): Mock;
}

type Mock<T = any> = {
  (...args: any[]): T;
  mockReturnValue: (value: T) => Mock<T>;
  mockImplementation: (fn: (...args: any[]) => T) => Mock<T>;
};

// Define our test types
interface MockVariable {
  id: string;
  name: string;
  variableCollectionId: string;
  scopes: string[];
}

interface MockFigma {
  variables: {
    getLocalVariables: Mock;
    getVariableCollectionById: Mock;
  };
  root: {
    children: any[];
  };
  notify: Mock;
  createText: Mock;
}

const mockFigma: MockFigma = {
  variables: {
    getLocalVariables: (() => []) as Mock,
    getVariableCollectionById: (() => null) as Mock
  },
  root: {
    children: []
  },
  notify: (() => {}) as Mock,
  createText: (() => {}) as Mock
};

// Make figma available globally without using declare global
(globalThis as any).figma = mockFigma;

describe('Variable Scanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('getAllVariables should handle empty variable list', async () => {
    mockFigma.variables.getLocalVariables.mockReturnValue([]);
    const variables = await getAllVariables();
    expect(variables).toHaveLength(0);
  });

  test('getAllVariables should process variables correctly', async () => {
    const mockVariables: MockVariable[] = [
      { id: '1', name: 'var1', variableCollectionId: 'col1', scopes: ['all'] },
      { id: '2', name: 'var2', variableCollectionId: 'col2', scopes: ['all'] }
    ];
    
    mockFigma.variables.getLocalVariables.mockReturnValue(mockVariables);
    mockFigma.variables.getVariableCollectionById
      .mockImplementation((id: string) => ({ name: `Collection ${id}` }));

    const variables = await getAllVariables();
    expect(variables).toHaveLength(2);
    expect(variables[0].collection).toBe('Collection col1');
  });

  test('checkNodeBindings should detect variable usage', () => {
    const mockNode = {
      boundVariables: {
        fill: { type: 'VARIABLE_ALIAS', id: 'test-id' }
      }
    } as any as SceneNode;

    const result = checkNodeBindings(mockNode, 'test-id');
    expect(result).toBe(true);
  });

  test('findUnusedVariables should identify unused variables', async () => {
    const mockVariables: MockVariable[] = [
      { id: 'used', name: 'UsedVar', variableCollectionId: 'col1', scopes: [] },
      { id: 'unused', name: 'UnusedVar', variableCollectionId: 'col1', scopes: [] }
    ];

    const mockNodes = [{
      type: 'RECTANGLE',
      name: 'Test Shape',
      boundVariables: {
        fill: { type: 'VARIABLE_ALIAS', id: 'used' }
      }
    }];

    mockFigma.variables.getLocalVariables.mockReturnValue(mockVariables);
    mockFigma.variables.getVariableCollectionById
      .mockReturnValue({ name: 'TestCollection' });
    mockFigma.root.children = [{ findAll: () => mockNodes }];

    const unusedVars = await findUnusedVariables();
    expect(unusedVars).toHaveLength(1);
    expect(unusedVars[0].id).toBe('unused');
  });

  test('findUnusedVariables should filter by selected collections', async () => {
    const mockVariables: MockVariable[] = [
      { id: 'var1', name: 'Var1', variableCollectionId: 'col1', scopes: [] },
      { id: 'var2', name: 'Var2', variableCollectionId: 'col2', scopes: [] },
      { id: 'var3', name: 'Var3', variableCollectionId: 'col1', scopes: [] }
    ];

    const mockNodes = [{
      type: 'RECTANGLE',
      name: 'Test Shape',
      boundVariables: {
        fill: { type: 'VARIABLE_ALIAS', id: 'var1' }
      }
    }];

    mockFigma.variables.getLocalVariables.mockReturnValue(mockVariables);
    mockFigma.variables.getVariableCollectionById
      .mockImplementation((id: string) => ({ name: `Collection ${id}` }));
    mockFigma.root.children = [{ findAll: () => mockNodes }];

    // Test filtering by col1
    const unusedInCol1 = await findUnusedVariables(['col1']);
    expect(unusedInCol1).toHaveLength(1);
    expect(unusedInCol1[0].id).toBe('var3');

    // Test filtering by col2
    const unusedInCol2 = await findUnusedVariables(['col2']);
    expect(unusedInCol2).toHaveLength(1);
    expect(unusedInCol2[0].id).toBe('var2');

    // Test with empty collection filter (should include all)
    const allUnused = await findUnusedVariables([]);
    expect(allUnused).toHaveLength(2);
    expect(allUnused.map(v => v.id)).toEqual(expect.arrayContaining(['var2', 'var3']));
  });
});