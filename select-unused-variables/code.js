"use strict";
/**
 * @fileoverview Plugin to find and highlight unused variables in Figma
 * This plugin scans through all nodes in the document to identify variables
 * that are defined but not used anywhere in the design.
 */
// Constants for variable binding properties
const BINDABLE_PROPERTIES = [
    'fills',
    'strokes',
    'effects',
    'opacity',
    'layoutGrids',
    'componentProperties'
];
// Add utility functions for variable ID handling
function getCleanVariableIds(rawIds) {
    return rawIds.map(id => id.replace(/^VariableID:/, ''));
}
function validateVariablesExist(ids) {
    return ids.every(id => {
        const exists = figma.variables.getVariableById(id);
        if (!exists) {
            console.warn(`⚠️ Variable not found: ${id}`);
            return false;
        }
        return true;
    });
}
/**
 * Recursively scans nodes for variable usage
 */
async function scanNodes(nodes, usedVars) {
    for (const node of nodes) {
        // Check component instances
        if (node.type === 'INSTANCE') {
            try {
                const mainComponent = node.mainComponent;
                if (mainComponent) {
                    await checkVariableUsage(mainComponent, usedVars);
                }
            }
            catch (error) {
                console.warn(`⚠️ Error checking component instance: ${error}`);
            }
        }
        // Check current node
        await checkVariableUsage(node, usedVars);
        // Recursively check children
        if ('children' in node) {
            await scanNodes(node.children, usedVars);
        }
    }
}
/**
 * Checks a node for variable usage across all bindable properties
 */
async function checkVariableUsage(node, usedVars) {
    var _a;
    try {
        // Check nested components
        if (node.type === 'INSTANCE' && node.mainComponent) {
            await checkVariableUsage(node.mainComponent, usedVars);
            // Also check component properties
            const properties = node.componentProperties;
            if (properties) {
                Object.values(properties).forEach(prop => {
                    if (prop.boundVariables) {
                        Object.values(prop.boundVariables).forEach(binding => {
                            const bindings = Array.isArray(binding) ? binding : [binding];
                            bindings.forEach(b => {
                                if ((b === null || b === void 0 ? void 0 : b.type) === 'VARIABLE_ALIAS' && b.id) {
                                    usedVars.add(b.id);
                                }
                            });
                        });
                    }
                });
            }
        }
        // Check bound variables in all bindable properties
        for (const prop of BINDABLE_PROPERTIES) {
            if ((_a = node[prop]) === null || _a === void 0 ? void 0 : _a.boundVariables) {
                const boundVars = node[prop].boundVariables;
                for (const binding of Object.values(boundVars)) {
                    const bindings = Array.isArray(binding) ? binding : [binding];
                    bindings.forEach((b) => {
                        if ((b === null || b === void 0 ? void 0 : b.type) === 'VARIABLE_ALIAS' && b.id) {
                            usedVars.add(b.id);
                        }
                    });
                }
            }
        }
        // Enhanced text style check
        if (node.type === 'TEXT') {
            const textNode = node;
            // Check text style
            const textStyleId = textNode.textStyleId;
            if (textStyleId) {
                const textStyle = figma.getStyleById(textStyleId);
                if (textStyle === null || textStyle === void 0 ? void 0 : textStyle.boundVariables) {
                    Object.values(textStyle.boundVariables).forEach(binding => {
                        const bindings = Array.isArray(binding) ? binding : [binding];
                        bindings.forEach(b => {
                            if ((b === null || b === void 0 ? void 0 : b.type) === 'VARIABLE_ALIAS' && b.id) {
                                usedVars.add(b.id);
                            }
                        });
                    });
                }
            }
            // Check text fills and effects
            const textProperties = ['fills', 'effects'];
            textProperties.forEach(prop => {
                const style = textNode[prop];
                if (style === null || style === void 0 ? void 0 : style.boundVariables) {
                    Object.values(style.boundVariables).forEach(binding => {
                        const bindings = Array.isArray(binding) ? binding : [binding];
                        bindings.forEach(b => {
                            if ((b === null || b === void 0 ? void 0 : b.type) === 'VARIABLE_ALIAS' && b.id) {
                                usedVars.add(b.id);
                            }
                        });
                    });
                }
            });
        }
    }
    catch (error) {
        console.warn(`⚠️ Error checking variable usage for node ${node.name}: ${error}`);
    }
}
/**
 * Gets truly unused variables by checking all possible usages
 */
async function getTrulyUnusedVariables() {
    const usedVars = new Set();
    try {
        // Check all modes in all collections first
        const collections = figma.variables.getLocalVariableCollections();
        collections.forEach(collection => {
            Object.values(collection.modes).forEach(mode => {
                const modeVariables = collection.variableIds.map(id => figma.variables.getVariableById(id));
                modeVariables.forEach(variable => {
                    if (variable === null || variable === void 0 ? void 0 : variable.id) {
                        // Check if the variable is referenced by other variables
                        collections.forEach(c => {
                            c.variableIds.forEach(vid => {
                                const v = figma.variables.getVariableById(vid);
                                if (v) {
                                    // Check all modes for this variable
                                    Object.entries(v.valuesByMode).forEach(([modeId, modeValue]) => {
                                        try {
                                            // Check direct value references
                                            if (typeof modeValue === 'object' && modeValue !== null) {
                                                // Cast to any to check internal structure
                                                const valueObj = modeValue;
                                                if (valueObj.type === 'VARIABLE_ALIAS' && valueObj.id === variable.id) {
                                                    usedVars.add(variable.id);
                                                }
                                            }
                                            // Check variable references in other variables
                                            collection.variableIds.forEach(otherId => {
                                                if (otherId !== variable.id) {
                                                    const otherVar = figma.variables.getVariableById(otherId);
                                                    if (otherVar && typeof otherVar.valuesByMode[modeId] === 'object') {
                                                        const value = otherVar.valuesByMode[modeId];
                                                        if ((value === null || value === void 0 ? void 0 : value.type) === 'VARIABLE_ALIAS' && value.id === variable.id) {
                                                            usedVars.add(variable.id);
                                                        }
                                                    }
                                                }
                                            });
                                        }
                                        catch (error) {
                                            console.warn(`⚠️ Error checking variable reference in mode ${modeId}: ${error}`);
                                        }
                                    });
                                }
                            });
                        });
                    }
                });
            });
        });
        // Scan all pages for direct usage
        for (const page of figma.root.children) {
            await scanNodes(page.children, usedVars);
        }
        // Check text styles and their variants
        const textStyles = figma.getLocalTextStyles();
        textStyles.forEach(style => {
            if (style.boundVariables) {
                Object.values(style.boundVariables).forEach(binding => {
                    const bindings = Array.isArray(binding) ? binding : [binding];
                    bindings.forEach(b => {
                        if ((b === null || b === void 0 ? void 0 : b.type) === 'VARIABLE_ALIAS' && b.id) {
                            usedVars.add(b.id);
                        }
                    });
                });
            }
        });
        // Filter unused variables
        const allVariables = figma.variables.getLocalVariables();
        return allVariables.filter(v => !usedVars.has(v.id));
    }
    catch (error) {
        console.error('❌ Error finding unused variables:', error);
        return [];
    }
}
// Constants
const UI_CONFIG = {
    width: 512,
    height: 600,
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
    width: UI_CONFIG.width,
    height: UI_CONFIG.height,
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
            // Check for bound variables
            if ('boundVariables' in node && node.boundVariables) {
                const boundVars = node.boundVariables;
                for (const [property, binding] of Object.entries(boundVars)) {
                    try {
                        if (!binding)
                            continue;
                        const bindings = Array.isArray(binding) ? binding : [binding];
                        for (const b of bindings) {
                            if (b && typeof b === 'object' && 'type' in b) {
                                // Check for valid variable binding
                                if (b.type === 'VARIABLE_ALIAS' && typeof b.id === 'string') {
                                    // Verify the variable exists
                                    const variable = figma.variables.getVariableById(b.id);
                                    if (variable) {
                                        usedIds.add(b.id);
                                        stats.variablesFound++;
                                        // Debug logging
                                        console.log(`🔗 Found variable usage:
                      Node: ${node.name}
                      Property: ${property}
                      Variable: ${variable.name}
                      ID: ${b.id}
                    `);
                                    }
                                }
                            }
                        }
                    }
                    catch (bindingError) {
                        console.warn(`⚠️ Error processing binding for property ${property} on node ${node.name}:`, bindingError);
                    }
                }
            }
            // Check for style references
            if ('styles' in node) {
                const styles = node.styles;
                if (styles && typeof styles === 'object') {
                    for (const [styleKey, styleValue] of Object.entries(styles)) {
                        try {
                            const style = figma.getStyleById(styleValue);
                            if (style === null || style === void 0 ? void 0 : style.boundVariables) {
                                Object.values(style.boundVariables).forEach(binding => {
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
                        catch (styleError) {
                            console.warn(`⚠️ Error processing style ${styleKey}:`, styleError);
                        }
                    }
                }
            }
        }
        catch (error) {
            console.error(`❌ Failed to process node ${node.name}:`, error);
            continue;
        }
    }
    return usedIds;
}
/**
 * Finds all unused variables in the document using batch processing
 */
async function findUnusedVariables(selectedCollections = []) {
    const stats = {
        startTime: Date.now(),
        nodesProcessed: 0,
        variablesFound: 0
    };
    try {
        console.log('🔍 Iniciando pesquisa de variáveis não utilizadas...');
        // Configurações
        const BATCH_SIZE = 15;
        const BATCH_DELAY = 50;
        const MAX_NODES_PER_PAGE = 500;
        const COMPLEX_NODE_THRESHOLD = 200;
        const GC_INTERVAL = 100;
        figma.ui.postMessage({ type: 'progress', message: 'Getting variables...' });
        // Validar e limpar variáveis antes de começar
        const allVariables = await getAllVariables(selectedCollections);
        const validVariables = allVariables.filter(v => {
            try {
                const variable = figma.variables.getVariableById(v.id);
                const collection = figma.variables.getVariableCollectionById(v.variableCollectionId);
                return !!variable && !!collection;
            }
            catch (error) {
                return false;
            }
        });
        console.log(`📊 Total de variáveis válidas: ${validVariables.length} de ${allVariables.length}`);
        const usedVarIds = new Set();
        // Função iterativa para coletar nós
        const collectNodesIteratively = (rootNode) => {
            const nodes = [];
            const queue = [{ node: rootNode, depth: 0 }];
            while (queue.length > 0 && nodes.length < MAX_NODES_PER_PAGE) {
                const current = queue.shift();
                if (!current)
                    continue;
                try {
                    const { node, depth } = current;
                    if (!node.id || !node.parent)
                        continue;
                    nodes.push(node);
                    if ('children' in node) {
                        const children = node.children;
                        if (children.length > COMPLEX_NODE_THRESHOLD) {
                            const sampledChildren = children
                                .slice(0, COMPLEX_NODE_THRESHOLD)
                                .filter((_, index) => index % 2 === 0);
                            for (const child of sampledChildren) {
                                if (depth < 5 && child.id && child.parent) {
                                    queue.push({ node: child, depth: depth + 1 });
                                }
                            }
                        }
                        else {
                            for (const child of children) {
                                if (depth < 8 && child.id && child.parent) {
                                    queue.push({ node: child, depth: depth + 1 });
                                }
                            }
                        }
                    }
                }
                catch (error) {
                    continue;
                }
            }
            return nodes;
        };
        // Processar cada página
        for (const page of figma.root.children) {
            try {
                console.log(`📄 Processando página: ${page.name}`);
                let processedCount = 0;
                for (let i = 0; i < page.children.length; i++) {
                    const rootNode = page.children[i];
                    try {
                        const nodes = collectNodesIteratively(rootNode);
                        for (let j = 0; j < nodes.length; j += BATCH_SIZE) {
                            const batch = nodes.slice(j, j + BATCH_SIZE);
                            try {
                                const batchUsedIds = await processBatch(batch, stats);
                                batchUsedIds.forEach(id => usedVarIds.add(id));
                                processedCount += batch.length;
                                if (processedCount % GC_INTERVAL === 0) {
                                    const progress = {
                                        currentBatch: Math.floor(processedCount / BATCH_SIZE),
                                        totalBatches: Math.ceil(page.children.length * COMPLEX_NODE_THRESHOLD / BATCH_SIZE),
                                        nodesProcessed: stats.nodesProcessed,
                                        variablesFound: stats.variablesFound,
                                        timeElapsed: Date.now() - stats.startTime
                                    };
                                    figma.ui.postMessage({ type: 'progress-update', progress });
                                    await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
                                }
                            }
                            catch (error) {
                                continue;
                            }
                        }
                        if (i % 5 === 0) {
                            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY * 2));
                        }
                    }
                    catch (error) {
                        continue;
                    }
                }
            }
            catch (error) {
                continue;
            }
        }
        // Verificar estilos
        const textStyles = figma.getLocalTextStyles();
        for (let i = 0; i < textStyles.length; i += BATCH_SIZE) {
            const styleBatch = textStyles.slice(i, i + BATCH_SIZE);
            styleBatch.forEach(style => {
                if (style.boundVariables) {
                    Object.values(style.boundVariables).forEach(binding => {
                        if (binding && typeof binding === 'object' && 'id' in binding) {
                            usedVarIds.add(binding.id);
                        }
                    });
                }
            });
            if (i % GC_INTERVAL === 0) {
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
            }
        }
        const unusedVars = validVariables.filter(v => !usedVarIds.has(v.id));
        return unusedVars.map(v => ({
            name: v.name,
            collection: v.collection,
            id: v.id
        }));
    }
    catch (error) {
        console.error('❌ Erro ao procurar variáveis não utilizadas:', error);
        throw new Error(`Falha ao procurar variáveis não utilizadas: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }
}
/**
 * Creates a text node with the analysis results and shows a success toast
 */
async function createTextNode(unusedVars) {
    try {
        const text = figma.createText();
        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
        if (unusedVars.length === 0) {
            text.characters = "✅ No unused variables found!";
            figma.notify("✅ No unused variables found!");
        }
        else {
            const byCollection = {};
            unusedVars.forEach(v => {
                if (!byCollection[v.collection])
                    byCollection[v.collection] = [];
                byCollection[v.collection].push(v);
            });
            let content = "📊 Unused Variables Report\n";
            content += "───────────────────────\n\n";
            content += `Total unused variables: ${unusedVars.length}\n\n`;
            Object.entries(byCollection).forEach(([collection, vars]) => {
                content += `${collection} (${vars.length})\n`;
                content += `${vars.map(v => `  • ${v.name}`).join('\n')}\n\n`;
            });
            text.characters = content;
            figma.notify(`✅ Report created with ${unusedVars.length} unused variables`);
        }
        const viewport = figma.viewport.bounds;
        text.x = viewport.x + 50;
        text.y = viewport.y + 50;
        return text;
    }
    catch (error) {
        console.error('❌ Error creating text node:', error);
        figma.notify('❌ Error creating text node', { error: true });
        return null;
    }
}
// Event Handlers
figma.ui.onmessage = async (msg) => {
    console.log('📨 Plugin received message:', msg.type, msg);
    switch (msg.type) {
        case 'init':
            try {
                const variables = figma.variables.getLocalVariables();
                const collections = figma.variables.getLocalVariableCollections().map(collection => ({
                    id: collection.id,
                    name: collection.name
                }));
                figma.ui.postMessage({
                    type: 'collections',
                    collections: collections
                });
                if (collections.length === 0) {
                    figma.notify('No variable collections found');
                }
            }
            catch (error) {
                figma.notify('Failed to initialize plugin');
            }
            break;
        case 'start-search':
            try {
                const { collections } = msg;
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
                figma.notify('Failed to print unused variables');
            }
            break;
    }
};
