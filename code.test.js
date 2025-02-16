"use strict";
const mockFigma = {
    variables: {
        getLocalVariables: (() => []),
        getVariableCollectionById: (() => null)
    },
    root: {
        children: []
    },
    notify: (() => { }),
    createText: (() => { })
};
// Make figma available globally without using declare global
globalThis.figma = mockFigma;
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
        const mockVariables = [
            { id: '1', name: 'var1', variableCollectionId: 'col1', scopes: ['all'] },
            { id: '2', name: 'var2', variableCollectionId: 'col2', scopes: ['all'] }
        ];
        mockFigma.variables.getLocalVariables.mockReturnValue(mockVariables);
        mockFigma.variables.getVariableCollectionById
            .mockImplementation((id) => ({ name: `Collection ${id}` }));
        const variables = await getAllVariables();
        expect(variables).toHaveLength(2);
        expect(variables[0].collection).toBe('Collection col1');
    });
    test('checkNodeBindings should detect variable usage', () => {
        const mockNode = {
            boundVariables: {
                fill: { type: 'VARIABLE_ALIAS', id: 'test-id' }
            }
        };
        const result = checkNodeBindings(mockNode, 'test-id');
        expect(result).toBe(true);
    });
    test('findUnusedVariables should identify unused variables', async () => {
        const mockVariables = [
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
        const mockVariables = [
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
            .mockImplementation((id) => ({ name: `Collection ${id}` }));
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
