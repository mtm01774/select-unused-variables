"use strict";
/**
 * @fileoverview Plugin to find and highlight unused variables in Figma
 * This plugin scans through all nodes in the document to identify variables
 * that are defined but not used anywhere in the design.
 */
// Constants
const UI_CONFIG = {
    width: 320,
    height: 480,
    defaultFontFamily: "Inter",
    defaultFontStyle: "Regular",
    fontSize: 14
};
const BATCH_CONFIG = {
    size: 1000,
    delay: 0,
    parallel: true,
    maxParallelBatches: 4
};
// Global state
let uiState = {
    analysisDone: false,
    canPrint: false,
    isLoading: false
};
// Show UI with specific dimensions
figma.showUI(__html__, {
    width: 320,
    height: 480,
    themeColors: true
});
console.log('🚀 Plugin started');
/**
 * Retrieves all variable collections from the current Figma file
 * @returns Array of collection info objects
 */
async function getAllCollections() {
    try {
        console.log('📚 Getting collections...');
        const collections = figma.variables.getLocalVariableCollections();
        console.log('📚 Raw collections:', collections);
        if (!collections || collections.length === 0) {
            console.log('⚠️ No collections found');
            return [];
        }
        const mappedCollections = collections.map(collection => ({
            id: collection.id,
            name: collection.name
        }));
        console.log('📚 Mapped collections:', mappedCollections);
        return mappedCollections;
    }
    catch (error) {
        console.error('❌ Error retrieving collections:', error);
        return [];
    }
}
/**
 * Retrieves all variables from the selected collections in the current Figma file
 * @param selectedCollections Array of selected collection IDs
 */
async function getAllVariables(selectedCollections) {
    try {
        const rawVariables = figma.variables.getLocalVariables();
        console.log(`📊 Found ${rawVariables.length} variables in total`);
        return rawVariables
            .filter(v => !(selectedCollections === null || selectedCollections === void 0 ? void 0 : selectedCollections.length) || selectedCollections.includes(v.variableCollectionId))
            .map(v => {
            try {
                const collection = figma.variables.getVariableCollectionById(v.variableCollectionId);
                return {
                    id: (v === null || v === void 0 ? void 0 : v.id) || '[invalid-id]',
                    name: typeof v.name === 'string' ? v.name : '[unnamed]',
                    collection: (collection === null || collection === void 0 ? void 0 : collection.name) || '[unknown-collection]',
                    variableCollectionId: v.variableCollectionId, // Added this field
                    scopes: v.scopes || []
                };
            }
            catch (error) {
                console.error(`❌ Error processing variable ${(v === null || v === void 0 ? void 0 : v.name) || 'unknown'}:`, error);
                return null;
            }
        }).filter(Boolean);
    }
    catch (error) {
        const errorMsg = `Failed to get variables: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error('🔥 Critical error in getAllVariables:', error);
        throw new Error(errorMsg);
    }
}
/**
 * Checks if a node has any variable bindings matching the given ID
 */
function checkNodeBindings(node, variableId) {
    try {
        if (!('boundVariables' in node) || !node.boundVariables)
            return false;
        const boundVars = node.boundVariables;
        return Object.keys(boundVars).some((property) => {
            const binding = boundVars[property];
            if (!binding)
                return false;
            const bindings = Array.isArray(binding) ? binding : [binding];
            return bindings.some(b => (b === null || b === void 0 ? void 0 : b.id) === variableId);
        });
    }
    catch (error) {
        console.error(`❌ Error checking bindings for node ${node.name}:`, error);
        return false;
    }
}
/**
 * Processes a batch of nodes to check for variable usage
 * @param nodes Array of nodes to process
 * @param stats Processing statistics for logging
 * @returns Set of used variable IDs
 */
async function processBatch(nodes, stats) {
    const usedIds = new Set();
    for (const node of nodes) {
        stats.nodesProcessed++;
        try {
            if ('boundVariables' in node && node.boundVariables) {
                Object.values(node.boundVariables).forEach(binding => {
                    const bindings = Array.isArray(binding) ? binding : [binding];
                    bindings.forEach(b => {
                        if ((b === null || b === void 0 ? void 0 : b.type) === 'VARIABLE_ALIAS' && typeof b.id === 'string') {
                            usedIds.add(b.id);
                            stats.variablesFound++;
                        }
                    });
                });
            }
        }
        catch (error) {
            console.warn(`Warning: Failed to process node ${node.name}:`, error);
        }
    }
    return usedIds;
}
/**
 * Finds all unused variables in the document using batch processing
 * @param selectedCollections Array of selected collection IDs to filter by
 */
async function findUnusedVariables(selectedCollections = []) {
    console.log('🔍 Starting unused variables search...');
    const stats = {
        startTime: Date.now(), // Changed from performance.now()
        nodesProcessed: 0,
        variablesFound: 0
    };
    try {
        // Notificar início da busca
        figma.ui.postMessage({
            type: 'progress',
            message: 'Getting variables...'
        });
        const variables = await getAllVariables(selectedCollections);
        const allNodes = [];
        // Notificar progresso
        figma.ui.postMessage({
            type: 'progress',
            message: 'Scanning pages...'
        });
        figma.root.children.forEach(page => {
            console.log(`📄 Scanning page: ${page.name}`);
            allNodes.push(...page.findAll());
        });
        console.log(`📊 Found ${allNodes.length} total nodes to scan`);
        const usedVariableIds = new Set();
        // Process nodes in batches
        for (let i = 0; i < allNodes.length; i += BATCH_CONFIG.size) {
            const batch = allNodes.slice(i, i + BATCH_CONFIG.size);
            const batchNumber = Math.floor(i / BATCH_CONFIG.size) + 1;
            const totalBatches = Math.ceil(allNodes.length / BATCH_CONFIG.size);
            // Atualizar progresso
            figma.ui.postMessage({
                type: 'progress',
                message: `Processing batch ${batchNumber}/${totalBatches}`,
                stats: `Nodes processed: ${stats.nodesProcessed}\nVariables found: ${stats.variablesFound}`
            });
            await new Promise(resolve => setTimeout(resolve, BATCH_CONFIG.delay));
            const batchIds = await processBatch(batch, stats);
            batchIds.forEach(id => usedVariableIds.add(id));
        }
        const unusedVariables = variables
            .filter(variable => !usedVariableIds.has(variable.id))
            .map(variable => {
            const collection = figma.variables.getVariableCollectionById(variable.variableCollectionId);
            return {
                name: variable.name,
                collection: (collection === null || collection === void 0 ? void 0 : collection.name) || 'No Collection',
                id: variable.id
            };
        });
        const executionTime = Date.now() - stats.startTime; // Changed from performance.now()
        console.log(`✅ Search completed in ${executionTime}ms`);
        console.log(`📊 Statistics:
    - Nodes processed: ${stats.nodesProcessed}
    - Variables found: ${stats.variablesFound}
    - Unused variables: ${unusedVariables.length}`);
        return unusedVariables;
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('🔥 Critical error in findUnusedVariables:', errorMsg);
        throw new Error(`Failed to find unused variables: ${errorMsg}`);
    }
}
/**
 * Creates a text node in the Figma document with the analysis results
 */
async function createTextNode(unusedVars) {
    try {
        const text = figma.createText();
        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
        const content = unusedVars.length === 0
            ? "No unused variables found!"
            : unusedVars.map((v, i) => `${i + 1}. ${v.name} (${v.collection})`).join('\n');
        text.characters = `Unused Variables (${unusedVars.length})\n\n${content}`;
        text.fontSize = 14;
        const viewport = figma.viewport.bounds;
        text.x = viewport.x + 50;
        text.y = viewport.y + 50;
        return text;
    }
    catch (error) {
        console.error('❌ Error creating text node:', error);
        return null;
    }
}
// Event Handlers
figma.ui.onmessage = async (msg) => {
    console.log('📨 Plugin received message:', msg.type);
    switch (msg.type) {
        case 'init':
            console.log('🚀 Initializing plugin...');
            try {
                // Get all variables first to check if we have any
                const variables = figma.variables.getLocalVariables();
                console.log(`📊 Found ${variables.length} variables`);
                // Get collections
                const collections = figma.variables.getLocalVariableCollections().map(collection => ({
                    id: collection.id,
                    name: collection.name
                }));
                console.log('📚 Found collections:', collections);
                figma.ui.postMessage({
                    type: 'collections',
                    collections: collections
                });
                if (collections.length === 0) {
                    figma.notify('No variable collections found');
                }
            }
            catch (error) {
                console.error('❌ Error during initialization:', error);
                figma.notify('Failed to initialize plugin');
            }
            break;
        case 'start-search':
            try {
                const { collections } = msg;
                console.log('🚀 Starting search...');
                const startTime = Date.now();
                const unusedVariables = await findUnusedVariables(collections);
                const executionTime = Date.now() - startTime;
                figma.ui.postMessage({
                    type: 'complete',
                    variables: unusedVariables,
                    stats: {
                        executionTime,
                        totalVariables: unusedVariables.length
                    }
                });
                figma.notify(`Found ${unusedVariables.length} unused variables in ${executionTime}ms`);
            }
            catch (error) {
                console.error('❌ Error:', error);
                figma.notify('An error occurred while searching');
                figma.ui.postMessage({
                    type: 'complete',
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
            break;
        case 'print-unused':
            try {
                const unusedVariables = await findUnusedVariables([]);
                const textNode = await createTextNode(unusedVariables);
                if (textNode) {
                    figma.viewport.scrollAndZoomIntoView([textNode]);
                }
            }
            catch (error) {
                console.error('❌ Error printing unused variables:', error);
                figma.notify('Failed to print unused variables');
            }
            break;
        // ...rest of the cases...
    }
};
