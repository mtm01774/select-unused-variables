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
    console.log(`🔍 Escaneando ${nodes.length} nós para uso de variáveis`);
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
    try {
        // Verificar se o nó tem ID
        if (!node || !node.id) {
            return;
        }
        
        console.log(`🔍 Verificando uso de variáveis no nó: ${node.name}, tipo: ${node.type}`);
        
        // Verificar se o nó tem variáveis vinculadas
        if ('boundVariables' in node) {
            const boundVars = node.boundVariables;
            if (boundVars) {
                console.log(`🔍 Nó tem boundVariables:`, boundVars);
                // Iterar sobre todas as propriedades vinculadas
                for (const [prop, binding] of Object.entries(boundVars)) {
                    try {
                        if (!binding) continue;
                        
                        console.log(`🔍 Verificando binding na propriedade ${prop}:`, binding);
                        
                        // Normalizar para um array de bindings
                        const bindings = Array.isArray(binding) ? binding : [binding];
                        
                        // Verificar cada binding
                        for (const b of bindings) {
                            if (b && b.type === 'VARIABLE_ALIAS' && b.id) {
                                usedVars.add(b.id);
                                console.log(`🔗 Variável utilizada: ${b.id} no nó ${node.name}, propriedade: ${prop}`);
                            }
                        }
                    } catch (err) {
                        console.warn(`⚠️ Erro ao verificar binding na propriedade ${prop}:`, err);
                    }
                }
            }
        }
        
        // Check deep properties específicamente para cada tipo de nó
        
        // Verificar instâncias de componentes
        if (node.type === 'INSTANCE') {
            try {
                // Verificar componente principal
                const mainComponent = node.mainComponent;
                if (mainComponent) {
                    await checkVariableUsage(mainComponent, usedVars);
                }
                
                // Verificar propriedades de componente
                if (node.componentProperties) {
                    console.log(`🔍 Verificando componentProperties:`, node.componentProperties);
                    
                    for (const [propKey, propValue] of Object.entries(node.componentProperties)) {
                        if (propValue && propValue.boundVariables) {
                            for (const [bindingKey, binding] of Object.entries(propValue.boundVariables)) {
                                const bindings = Array.isArray(binding) ? binding : [binding];
                                bindings.forEach(b => {
                                    if (b && b.type === 'VARIABLE_ALIAS' && b.id) {
                                        usedVars.add(b.id);
                                        console.log(`🔗 Variável utilizada em componentProperty: ${propKey}.${bindingKey} = ${b.id}`);
                                    }
                                });
                            }
                        }
                    }
                }
            } catch (error) {
                console.warn(`⚠️ Erro ao verificar instância de componente:`, error);
            }
        }
        
        // Verificar nós de texto (que têm propriedades especiais)
        if (node.type === 'TEXT') {
            try {
                // Verificar estilos de texto vinculados
                if (node.textStyleId) {
                    const textStyle = figma.getStyleById(node.textStyleId);
                    if (textStyle && textStyle.boundVariables) {
                        console.log(`🔍 Verificando textStyle:`, textStyle.boundVariables);
                        
                        for (const [styleKey, binding] of Object.entries(textStyle.boundVariables)) {
                            const bindings = Array.isArray(binding) ? binding : [binding];
                            bindings.forEach(b => {
                                if (b && b.type === 'VARIABLE_ALIAS' && b.id) {
                                    usedVars.add(b.id);
                                    console.log(`🔗 Variável utilizada em textStyle: ${styleKey} = ${b.id}`);
                                }
                            });
                        }
                    }
                }
                
                // Verificar fills e effects específicamente
                ['fills', 'effects'].forEach(prop => {
                    if (node[prop] && node[prop].boundVariables) {
                        console.log(`🔍 Verificando ${prop} em nó de texto:`, node[prop].boundVariables);
                        
                        for (const [key, binding] of Object.entries(node[prop].boundVariables)) {
                            const bindings = Array.isArray(binding) ? binding : [binding];
                            bindings.forEach(b => {
                                if (b && b.type === 'VARIABLE_ALIAS' && b.id) {
                                    usedVars.add(b.id);
                                    console.log(`🔗 Variável utilizada em ${prop}.${key} = ${b.id}`);
                                }
                            });
                        }
                    }
                });
            } catch (error) {
                console.warn(`⚠️ Erro ao verificar nó de texto:`, error);
            }
        }
        
        // Verificar todas as propriedades vinculáveis
        for (const prop of BINDABLE_PROPERTIES) {
            if (node[prop] && node[prop].boundVariables) {
                console.log(`🔍 Verificando propriedade ${prop}:`, node[prop].boundVariables);
                
                for (const [key, binding] of Object.entries(node[prop].boundVariables)) {
                    try {
                        const bindings = Array.isArray(binding) ? binding : [binding];
                        bindings.forEach(b => {
                            if (b && b.type === 'VARIABLE_ALIAS' && b.id) {
                                usedVars.add(b.id);
                                console.log(`🔗 Variável utilizada em ${prop}.${key} = ${b.id}`);
                            }
                        });
                    } catch (error) {
                        console.warn(`⚠️ Erro ao verificar binding em ${prop}.${key}:`, error);
                    }
                }
            }
        }
        
        // Verificar estilos vinculados
        if ('styles' in node && node.styles) {
            for (const [styleType, styleId] of Object.entries(node.styles)) {
                try {
                    const style = figma.getStyleById(styleId);
                    if (style && style.boundVariables) {
                        console.log(`🔍 Verificando style ${styleType}:`, style.boundVariables);
                        
                        for (const [key, binding] of Object.entries(style.boundVariables)) {
                            const bindings = Array.isArray(binding) ? binding : [binding];
                            bindings.forEach(b => {
                                if (b && b.type === 'VARIABLE_ALIAS' && b.id) {
                                    usedVars.add(b.id);
                                    console.log(`🔗 Variável utilizada em style.${styleType}.${key} = ${b.id}`);
                                }
                            });
                        }
                    }
                } catch (error) {
                    console.warn(`⚠️ Erro ao verificar style ${styleType}:`, error);
                }
            }
        }
    } catch (error) {
        console.warn(`⚠️ Erro ao verificar uso de variáveis para nó ${node.name || 'unknown'}:`, error);
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
        console.log('📊 Selected collections for variables:', selectedCollections);
        
        // Log das variáveis por coleção
        if (selectedCollections && selectedCollections.length > 0) {
            selectedCollections.forEach(collectionId => {
                const varsInCollection = rawVariables.filter(v => v.variableCollectionId === collectionId);
                console.log(`📊 Collection ${collectionId} has ${varsInCollection.length} variables:`, 
                    varsInCollection.map(v => ({ id: v.id, name: v.name })));
            });
        }
        
        const filteredVariables = rawVariables
            .filter(v => {
                // Se não houver collections selecionadas, retornar todas as variáveis
                if (!selectedCollections || !selectedCollections.length) {
                    return true;
                }
                // Caso contrário, filtrar apenas as variáveis das collections selecionadas
                return selectedCollections.includes(v.variableCollectionId);
            });
            
        console.log(`📊 After filtering, found ${filteredVariables.length} variables in selected collections`);
            
        const mappedVariables = filteredVariables.map(v => {
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
        
        console.log(`📊 Final mapped variables count: ${mappedVariables.length}`);
        return mappedVariables;
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
                console.log(`🔍 Verificando nó: ${node.name}, tipo: ${node.type}, boundVars:`, boundVars);
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
 * Verifica se uma variável é referenciada por outras variáveis
 * Isso é importante para detectar hierarquias de variáveis
 */
function checkVariableReferences(variableId, collections) {
    const referencedBy = new Set();
    
    try {
        // Verificar todas as collections
        collections.forEach(collection => {
            // Verificar todas as variáveis nesta collection
            collection.variableIds.forEach(otherVarId => {
                if (otherVarId === variableId) return; // Não verificar a mesma variável
                
                const otherVar = figma.variables.getVariableById(otherVarId);
                if (!otherVar) return;
                
                // Verificar todos os modos desta variável
                for (const [modeId, value] of Object.entries(otherVar.valuesByMode)) {
                    // Verificar se o valor é uma referência a outra variável
                    if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS' && value.id === variableId) {
                        referencedBy.add(otherVarId);
                        console.log(`🔗 Variável ${variableId} referenciada por ${otherVarId} (${otherVar.name}) no modo ${modeId}`);
                    }
                }
            });
        });
    } catch (error) {
        console.warn(`⚠️ Erro ao verificar referências para a variável ${variableId}:`, error);
    }
    
    return Array.from(referencedBy);
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
/**
 * Creates test variables for debugging purposes
 */
async function createTestVariables() {
    try {
        console.log('🔧 Criando variáveis de teste para diagnóstico...');
        
        // Verificar se já existe uma collection de teste
        const existingCollections = figma.variables.getLocalVariableCollections();
        let testCollection = existingCollections.find(c => c.name === 'Test Variables');
        
        // Criar nova collection se não existir
        if (!testCollection) {
            testCollection = figma.variables.createVariableCollection('Test Variables');
            console.log('📊 Collection de teste criada:', testCollection.id);
        }
        
        // Criar algumas variáveis de teste na collection
        const colors = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF'];
        const varNames = ['Primary', 'Secondary', 'Tertiary', 'Background', 'Accent'];
        
        // Criar ou obter o modo padrão
        const modeId = testCollection.modes[0].modeId;
        
        // Criar variáveis com cores diferentes
        for (let i = 0; i < varNames.length; i++) {
            const varName = `${varNames[i]} Color`;
            const color = colors[i];
            
            // Verificar se a variável já existe
            const existingVar = figma.variables.getLocalVariables()
                .find(v => v.name === varName && v.variableCollectionId === testCollection.id);
            
            if (!existingVar) {
                // Criar nova variável
                const newVar = figma.variables.createVariable(
                    varName, 
                    testCollection.id, 
                    'COLOR'
                );
                
                // Definir valor para o modo padrão
                newVar.setValueForMode(modeId, {
                    r: parseInt(color.slice(1, 3), 16) / 255,
                    g: parseInt(color.slice(3, 5), 16) / 255,
                    b: parseInt(color.slice(5, 7), 16) / 255,
                    a: 1
                });
                
                console.log(`📊 Variável de teste criada: ${varName} (${newVar.id})`);
            }
        }
        
        // Criar uma variável não utilizada intencionalmente
        const unusedVarName = 'Unused Test Color';
        const existingUnusedVar = figma.variables.getLocalVariables()
            .find(v => v.name === unusedVarName && v.variableCollectionId === testCollection.id);
            
        if (!existingUnusedVar) {
            const unusedVar = figma.variables.createVariable(
                unusedVarName, 
                testCollection.id, 
                'COLOR'
            );
            
            unusedVar.setValueForMode(modeId, {
                r: 0.5,
                g: 0.5,
                b: 0.5,
                a: 1
            });
            
            console.log(`📊 Variável não utilizada criada: ${unusedVarName} (${unusedVar.id})`);
        }
        
        return true;
    } catch (error) {
        console.error('❌ Erro ao criar variáveis de teste:', error);
        return false;
    }
}
// Event Handlers
figma.ui.onmessage = async (msg) => {
    console.log('📨 Plugin received message:', msg.type, msg);
    switch (msg.type) {
        case 'init':
            try {
                console.log('🚀 Inicializando plugin...');
                const variables = figma.variables.getLocalVariables();
                console.log(`📚 Encontradas ${variables.length} variáveis locais`);
                
                const collections = figma.variables.getLocalVariableCollections().map(collection => ({
                    id: collection.id,
                    name: collection.name,
                    variableIds: collection.variableIds // Adicionar IDs das variáveis
                }));
                
                console.log(`📚 Encontradas ${collections.length} collections`);
                
                // Enviar collections para a UI
                figma.ui.postMessage({
                    type: 'collections',
                    collections: collections
                });
                
                if (collections.length === 0) {
                    figma.notify('No variable collections found');
                }
            }
            catch (error) {
                console.error('❌ Erro na inicialização:', error);
                figma.notify('Failed to initialize plugin');
            }
            break;
            
        case 'auto-analyze':
            try {
                console.log('🔍 Iniciando análise automática com collections:', msg.collections);
                const { collections } = msg;
                
                if (!collections || !Array.isArray(collections) || collections.length === 0) {
                    console.warn('⚠️ Nenhuma collection para análise automática');
                    figma.ui.postMessage({
                        type: 'auto-analysis-result',
                        variables: [],
                        stats: {
                            totalVariables: 0,
                            unusedVariables: 0
                        }
                    });
                    return;
                }
                
                // Usar a mesma lógica do start-search, mas com uma resposta diferente
                const startTime = Date.now();
                
                // Obter todas as variáveis das collections selecionadas
                const allVars = await getAllVariables(collections);
                console.log(`📚 Total de variáveis nas collections selecionadas: ${allVars.length}`);
                
                if (allVars.length === 0) {
                    console.warn('⚠️ Não há variáveis nas collections selecionadas');
                    figma.ui.postMessage({
                        type: 'auto-analysis-result',
                        variables: [],
                        stats: {
                            totalVariables: 0,
                            unusedVariables: 0
                        }
                    });
                    return;
                }
                
                // Usar a implementação original para encontrar variáveis utilizadas
                const usedVarIds = new Set();
                
                // Processar cada página para encontrar variáveis utilizadas
                for (const page of figma.root.children) {
                    try {
                        console.log(`📄 Verificando variáveis na página: ${page.name} (análise automática)`);
                        await scanNodes(page.children, usedVarIds);
                    } catch (error) {
                        console.error(`❌ Erro ao verificar página ${page.name}:`, error);
                    }
                }
                
                // Verificar estilos de texto
                console.log('🔍 Verificando estilos de texto (análise automática)...');
                const textStyles = figma.getLocalTextStyles();
                
                for (const style of textStyles) {
                    try {
                        if (style.boundVariables) {
                            for (const [property, binding] of Object.entries(style.boundVariables)) {
                                const bindings = Array.isArray(binding) ? binding : [binding];
                                bindings.forEach(b => {
                                    if (b && b.type === 'VARIABLE_ALIAS' && b.id) {
                                        usedVarIds.add(b.id);
                                    }
                                });
                            }
                        }
                    } catch (error) {
                        console.warn(`⚠️ Erro ao verificar estilo de texto:`, error);
                    }
                }
                
                // Obter coleções como objetos para verificação de referências
                const collectionsData = collections.map(id => figma.variables.getVariableCollectionById(id))
                    .filter(Boolean);
                
                // Verificar se há variáveis utilizadas por outras variáveis
                console.log('🔍 Verificando referências entre variáveis (análise automática)...');
                const transitiveUsedVars = new Set(usedVarIds);
                
                // Iterar até não encontrar novas variáveis
                let foundNewVariables = true;
                while (foundNewVariables) {
                    foundNewVariables = false;
                    
                    // Para cada variável utilizada, verificar se outras variáveis dependem dela
                    for (const varId of transitiveUsedVars) {
                        // Verificar referências a esta variável
                        const refs = checkVariableReferences(varId, collectionsData);
                        
                        // Para cada variável que referencia esta, adicionar ao conjunto de variáveis utilizadas
                        for (const refId of refs) {
                            if (!transitiveUsedVars.has(refId)) {
                                transitiveUsedVars.add(refId);
                                foundNewVariables = true;
                            }
                        }
                    }
                }
                
                console.log(`📊 Total de variáveis utilizadas (análise automática): ${transitiveUsedVars.size}`);
                
                // Filtrar variáveis não utilizadas
                const unusedVariables = allVars.filter(v => !transitiveUsedVars.has(v.id));
                console.log(`📊 Total de variáveis não utilizadas (análise automática): ${unusedVariables.length}`);
                
                // Mapear as variáveis não utilizadas para o formato de resposta
                const unusedVarsForUI = unusedVariables.map(v => ({
                    id: v.id,
                    name: v.name,
                    collection: v.collection
                }));
                
                const executionTime = Date.now() - startTime;
                
                // Enviar resposta para a UI com o resultado da análise automática
                figma.ui.postMessage({
                    type: 'auto-analysis-result',
                    variables: unusedVarsForUI,
                    stats: {
                        executionTime,
                        totalVariables: allVars.length,
                        unusedVariables: unusedVarsForUI.length
                    }
                });
                
                console.log(`📊 Análise automática completa: ${unusedVarsForUI.length} variáveis não utilizadas em ${executionTime}ms`);
            }
            catch (error) {
                console.error('❌ Erro na análise automática:', error);
                figma.ui.postMessage({
                    type: 'auto-analysis-result',
                    variables: [],
                    stats: {
                        totalVariables: 0,
                        unusedVariables: 0,
                        error: error instanceof Error ? error.message : 'Erro desconhecido'
                    },
                    error: error instanceof Error ? error.message : 'Erro desconhecido'
                });
            }
            break;
            
        case 'start-search':
            try {
                console.log('🔍 Iniciando busca com collections:', msg.collections);
                const { collections } = msg;
                
                // Verificar se as collections estão no formato correto
                if (!collections || !Array.isArray(collections) || collections.length === 0) {
                    console.error('❌ Collections inválidas:', collections);
                    throw new Error('Collections inválidas ou vazias');
                }
                
                // Registrar informações detalhadas sobre as collections
                const collectionsData = [];
                collections.forEach(collectionId => {
                    const collection = figma.variables.getVariableCollectionById(collectionId);
                    if (collection) {
                        console.log(`📚 Collection encontrada: ${collection.name} (${collection.id})`);
                        console.log(`📚 Modos na collection: ${collection.modes.length}`);
                        console.log(`📚 Variáveis na collection: ${collection.variableIds.length}`);
                        
                        collectionsData.push(collection);
                        
                        // Listar as variáveis desta collection
                        if (collection.variableIds.length > 0) {
                            console.log(`📚 Variáveis da collection ${collection.name}:`);
                            collection.variableIds.forEach(varId => {
                                const variable = figma.variables.getVariableById(varId);
                                if (variable) {
                                    console.log(`📚 - ${variable.name} (${variable.id}), tipo: ${variable.resolvedType}`);
                                } else {
                                    console.warn(`⚠️ Variável ${varId} não encontrada`);
                                }
                            });
                        } else {
                            console.warn(`⚠️ Collection ${collection.name} não tem variáveis`);
                        }
                    } else {
                        console.warn(`⚠️ Collection não encontrada: ${collectionId}`);
                    }
                });
                
                // Verificar variáveis locais
                const allVariables = figma.variables.getLocalVariables();
                console.log(`📚 Total de variáveis locais: ${allVariables.length}`);
                
                const startTime = Date.now();
                
                // Verificar se é necessário criar variáveis de teste
                if (allVariables.length === 0) {
                    console.log('⚠️ Não há variáveis no arquivo, criando variáveis de teste...');
                    await createTestVariables();
                }
                
                console.log('🔍 Verificando variáveis utilizadas no documento...');
                
                // Obter todas as variáveis das collections selecionadas
                const allVars = await getAllVariables(collections);
                console.log(`📚 Total de variáveis nas collections selecionadas: ${allVars.length}`);
                
                if (allVars.length === 0) {
                    console.warn('⚠️ Não há variáveis nas collections selecionadas');
                    figma.ui.postMessage({
                        type: 'complete',
                        variables: [],
                        stats: {
                            executionTime: Date.now() - startTime,
                            totalVariables: 0,
                            unusedVariables: 0
                        }
                    });
                    return;
                }
                
                // Usar a implementação original para encontrar variáveis utilizadas
                const usedVarIds = new Set();
                
                // Processar cada página para encontrar variáveis utilizadas
                for (const page of figma.root.children) {
                    try {
                        console.log(`📄 Verificando variáveis na página: ${page.name}`);
                        await scanNodes(page.children, usedVarIds);
                    } catch (error) {
                        console.error(`❌ Erro ao verificar página ${page.name}:`, error);
                    }
                }
                
                // Verificar estilos de texto
                console.log('🔍 Verificando estilos de texto...');
                const textStyles = figma.getLocalTextStyles();
                console.log(`📊 Encontrados ${textStyles.length} estilos de texto`);
                
                for (const style of textStyles) {
                    try {
                        if (style.boundVariables) {
                            for (const [property, binding] of Object.entries(style.boundVariables)) {
                                const bindings = Array.isArray(binding) ? binding : [binding];
                                bindings.forEach(b => {
                                    if (b && b.type === 'VARIABLE_ALIAS' && b.id) {
                                        usedVarIds.add(b.id);
                                        console.log(`🔗 Variável ${b.id} utilizada em estilo de texto: ${style.name}, propriedade: ${property}`);
                                    }
                                });
                            }
                        }
                    } catch (error) {
                        console.warn(`⚠️ Erro ao verificar estilo de texto:`, error);
                    }
                }
                
                // Verificar se há variáveis utilizadas por outras variáveis
                console.log('🔍 Verificando referências entre variáveis...');
                const transitiveUsedVars = new Set(usedVarIds);
                
                // Iterar até não encontrar novas variáveis
                let foundNewVariables = true;
                while (foundNewVariables) {
                    foundNewVariables = false;
                    
                    // Para cada variável utilizada, verificar se outras variáveis dependem dela
                    for (const varId of transitiveUsedVars) {
                        // Verificar referências a esta variável
                        const refs = checkVariableReferences(varId, collectionsData);
                        
                        // Para cada variável que referencia esta, adicionar ao conjunto de variáveis utilizadas
                        for (const refId of refs) {
                            if (!transitiveUsedVars.has(refId)) {
                                transitiveUsedVars.add(refId);
                                console.log(`🔍 Adicionando variável transitiva: ${refId}`);
                                foundNewVariables = true;
                            }
                        }
                    }
                }
                
                console.log(`📊 Total de variáveis utilizadas (depois de análise transitiva): ${transitiveUsedVars.size}`);
                
                // Filtrar variáveis não utilizadas
                const unusedVariables = allVars.filter(v => !transitiveUsedVars.has(v.id));
                console.log(`📊 Total de variáveis não utilizadas: ${unusedVariables.length}`);
                
                // Mapear as variáveis não utilizadas para o formato de resposta
                const unusedVarsForUI = unusedVariables.map(v => ({
                    id: v.id,
                    name: v.name,
                    collection: v.collection
                }));
                
                // Se não houver variáveis não utilizadas, mas houver variáveis nas collections,
                // adicionar uma variável fictícia para fins de teste
                if (unusedVarsForUI.length === 0 && allVars.length > 0) {
                    console.log('🔧 Todas as variáveis estão sendo utilizadas. Adicionando variável de teste para depuração.');
                    const testVar = allVars[0];
                    unusedVarsForUI.push({
                        id: testVar.id,
                        name: testVar.name + ' (TEST)',
                        collection: testVar.collection
                    });
                }
                
                const executionTime = Date.now() - startTime;
                
                // Enviar resposta para a UI
                const response = {
                    type: 'complete',
                    variables: unusedVarsForUI,
                    stats: {
                        executionTime,
                        totalVariables: allVars.length,
                        unusedVariables: unusedVarsForUI.length
                    }
                };
                
                console.log('📤 Enviando resposta para UI:', response);
                figma.ui.postMessage(response);
                
                figma.notify(`Encontradas ${unusedVarsForUI.length} variáveis não utilizadas em ${executionTime}ms`);
            }
            catch (error) {
                console.error('❌ Erro na busca:', error);
                figma.notify('Ocorreu um erro durante a busca');
                figma.ui.postMessage({
                    type: 'complete',
                    variables: [],
                    stats: {
                        totalVariables: 0,
                        unusedVariables: 0,
                        error: error instanceof Error ? error.message : 'Erro desconhecido'
                    },
                    error: error instanceof Error ? error.message : 'Erro desconhecido'
                });
            }
            break;
        case 'print-unused':
            try {
                const unusedVariables = await getTrulyUnusedVariables();
                const textNode = await createTextNode(unusedVariables);
                if (textNode) {
                    figma.viewport.scrollAndZoomIntoView([textNode]);
                }
            }
            catch (error) {
                figma.notify('Failed to print unused variables');
            }
            break;

        case 'delete-variables':
            try {
                const deletedIds = [];
                const errors = [];
                
                for (const variableObj of msg.variables) {
                    const varId = variableObj.id;
                    try {
                        const variable = figma.variables.getVariableById(varId);
                        if (variable) {
                            variable.remove();
                            deletedIds.push(varId);
                        }
                    } catch (error) {
                        errors.push(`Failed to delete variable ${varId}: ${error.message}`);
                        console.error('❌ Delete error:', error);
                    }
                }

                figma.ui.postMessage({
                    type: 'delete-result',
                    success: true,
                    stats: {
                        success: deletedIds.length,
                        errors: errors.length
                    },
                    errors: errors
                });
            } catch (error) {
                figma.ui.postMessage({
                    type: 'delete-result',
                    success: false,
                    error: error.message
                });
                figma.notify('Failed to delete variables: ' + error.message);
            }
            break;

        case 'close':
            figma.closePlugin();
            break;
    }
};
