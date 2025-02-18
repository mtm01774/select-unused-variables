/**
 * @fileoverview Plugin to find and highlight unused variables in Figma
 * This plugin scans through all nodes in the document to identify variables
 * that are defined but not used anywhere in the design.
 */

// Types and Interfaces
interface VariableUsage {
  node: SceneNode;
  property: string;
}

interface VariableResult {
  name: string;
  collection: string;
  id: string;
}

interface UIState {
  analysisDone: boolean;
  canPrint: boolean;
  isLoading: boolean;
  selectedVariables: Set<string>;
  deletionSuccess: boolean;
}

interface ProcessingStats {
  startTime: number;
  nodesProcessed: number;
  variablesFound: number;
}

type VariableBinding = {
  id: string;
  type: 'VARIABLE_ALIAS' | 'VARIABLE';
};

interface BatchConfig {
  size: number;
  delay: number;
  parallel: boolean;
  maxParallelBatches: number;
}

interface ProgressUpdate {
  currentBatch: number;
  totalBatches: number;
  nodesProcessed: number;
  variablesFound: number;
  timeElapsed: number;
}

// Constants for variable binding properties
const BINDABLE_PROPERTIES = [
  'fills',
  'strokes',
  'effects',
  'opacity',
  'layoutGrids',
  'componentProperties'
] as const;

// Add new interface for collection
interface CollectionInfo {
  name: string;
  id: string;
}

// Rename our interface to avoid conflict with Figma's types
interface VariableInfo {
  id: string;
  name: string;
  collection: string;
  variableCollectionId: string;  // Added this field
  scopes: string[];
  usages: VariableUsageMap[];
  collectionName: string;
  modes: {
    [modeId: string]: {
      value: any;
      references: string[];
    }
  };
}

interface VariableAlias {
  id: string;
  type: 'VARIABLE_ALIAS';
}

// Add utility functions for variable ID handling
function getCleanVariableIds(rawIds: string[]): string[] {
  return rawIds.map(id => id.replace(/^VariableID:/, ''));
}

function validateVariablesExist(ids: string[]): boolean {
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
async function scanNodes(nodes: ReadonlyArray<SceneNode>, usedVars: Set<string>): Promise<void> {
  for (const node of nodes) {
    // Check component instances
    if (node.type === 'INSTANCE') {
      try {
        const mainComponent = node.mainComponent;
        if (mainComponent) {
          await checkVariableUsage(mainComponent, usedVars);
        }
      } catch (error) {
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
async function checkVariableUsage(node: BaseNode, usedVars: Set<string>): Promise<void> {
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
                if (b?.type === 'VARIABLE_ALIAS' && b.id) {
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
      if ((node as any)[prop]?.boundVariables) {
        const boundVars = (node as any)[prop].boundVariables;
        for (const binding of Object.values(boundVars)) {
          const bindings = Array.isArray(binding) ? binding : [binding];
          bindings.forEach((b: VariableBinding | undefined) => {
            if (b?.type === 'VARIABLE_ALIAS' && b.id) {
              usedVars.add(b.id);
            }
          });
        }
      }
    }

    // Enhanced text style check
    if (node.type === 'TEXT') {
      const textNode = node as TextNode;
      
      // Check text style
      const textStyleId = textNode.textStyleId as string;
      if (textStyleId) {
        const textStyle = figma.getStyleById(textStyleId);
        if (textStyle?.boundVariables) {
          Object.values(textStyle.boundVariables).forEach(binding => {
            const bindings = Array.isArray(binding) ? binding : [binding];
            bindings.forEach(b => {
              if (b?.type === 'VARIABLE_ALIAS' && b.id) {
                usedVars.add(b.id);
              }
            });
          });
        }
      }

      // Check text fills and effects
      const textProperties = ['fills', 'effects'] as const;
      textProperties.forEach(prop => {
        const style = (textNode as any)[prop];
        if (style?.boundVariables) {
          Object.values(style.boundVariables).forEach(binding => {
            const bindings = Array.isArray(binding) ? binding : [binding];
            bindings.forEach(b => {
              if (b?.type === 'VARIABLE_ALIAS' && b.id) {
                usedVars.add(b.id);
              }
            });
          });
        }
      });
    }
  } catch (error) {
    console.warn(`⚠️ Error checking variable usage for node ${node.name}: ${error}`);
  }
}

/**
 * Gets truly unused variables by checking all possible usages
 */
async function getTrulyUnusedVariables(): Promise<Variable[]> {
  const usedVars = new Set<string>();
  
  try {
    // Check all modes in all collections first
    const collections = figma.variables.getLocalVariableCollections();
    collections.forEach(collection => {
      Object.values(collection.modes).forEach(mode => {
        const modeVariables = collection.variableIds.map(id => figma.variables.getVariableById(id));
        modeVariables.forEach(variable => {
          if (variable?.id) {
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
                        const valueObj = modeValue as any;
                        if (valueObj.type === 'VARIABLE_ALIAS' && valueObj.id === variable.id) {
                          usedVars.add(variable.id);
                        }
                      }
                      
                      // Check variable references in other variables
                      collection.variableIds.forEach(otherId => {
                        if (otherId !== variable.id) {
                          const otherVar = figma.variables.getVariableById(otherId);
                          if (otherVar && typeof otherVar.valuesByMode[modeId] === 'object') {
                            const value = otherVar.valuesByMode[modeId] as any;
                            if (value?.type === 'VARIABLE_ALIAS' && value.id === variable.id) {
                              usedVars.add(variable.id);
                            }
                          }
                        }
                      });
                    } catch (error) {
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
            if (b?.type === 'VARIABLE_ALIAS' && b.id) {
              usedVars.add(b.id);
            }
          });
        });
      }
    });

    // Filter unused variables
    const allVariables = figma.variables.getLocalVariables();
    return allVariables.filter(v => !usedVars.has(v.id));
  } catch (error) {
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
} as const;

const BATCH_CONFIG: BatchConfig = {
  size: 1000,
  delay: 0,
  parallel: true,
  maxParallelBatches: 4
} as const;

// Global state
let uiState: UIState = {
  analysisDone: false,
  canPrint: false,
  isLoading: false,
  selectedVariables: new Set<string>(),
  deletionSuccess: false
};

// Show UI with specific dimensions
figma.showUI(__html__, { 
  width: UI_CONFIG.width,
  height: UI_CONFIG.height,
  themeColors: true
});

console.log('🚀 Plugin started');

// Adicionar após as interfaces existentes
interface StatusUpdate {
  analyzed: number;
  unused: number;
  errors: number;
  total: number;
}

// Adicionar após a declaração das constantes
let statusStats: StatusUpdate = {
  analyzed: 0,
  unused: 0,
  errors: 0,
  total: 0
};

// Função para enviar atualizações de status para a UI
function updateStatus(stats: Partial<StatusUpdate>) {
  statusStats = {
    ...statusStats,
    ...stats
  };
  
  figma.ui.postMessage({
    type: 'status-update',
    stats: statusStats
  });
}

// Adicionar após figma.showUI
// Configurar event listeners
figma.on('selectionchange', () => {
  const selection = figma.currentPage.selection;
  updateStatus({
    analyzed: selection.length
  });
});

figma.on('variableschanged', () => {
  const variables = figma.variables.getLocalVariables();
  updateStatus({
    total: variables.length
  });
});

/**
 * Retrieves all variable collections from the current Figma file
 * @returns Array of collection info objects
 */
async function getAllCollections(): Promise<CollectionInfo[]> {
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
  } catch (error) {
    console.error('❌ Error retrieving collections:', error);
    return [];
  }
}

/**
 * Retrieves all variables from the selected collections in the current Figma file
 * @param selectedCollections Array of selected collection IDs
 */
async function getAllVariables(selectedCollections?: string[]): Promise<VariableInfo[]> {
  try {
    const rawVariables = figma.variables.getLocalVariables();
    console.log(`📊 Found ${rawVariables.length} variables in total`);
    
    return rawVariables
      .filter(v => !selectedCollections?.length || selectedCollections.includes(v.variableCollectionId))
      .map(v => {
        try {
          const collection = figma.variables.getVariableCollectionById(v.variableCollectionId);
          return {
            id: v?.id || '[invalid-id]',
            name: typeof v.name === 'string' ? v.name : '[unnamed]',
            collection: collection?.name || '[unknown-collection]',
            variableCollectionId: v.variableCollectionId,  // Added this field
            scopes: v.scopes || [],
            usages: [],
            collectionName: collection?.name || '[unknown-collection]',
            modes: {}
          };
        } catch (error) {
          console.error(`❌ Error processing variable ${v?.name || 'unknown'}:`, error);
          return null;
        }
      }).filter(Boolean) as VariableInfo[];
    
  } catch (error) {
    const errorMsg = `Failed to get variables: ${error instanceof Error ? error.message : 'Unknown error'}`;
    console.error('🔥 Critical error in getAllVariables:', error);
    throw new Error(errorMsg);
  }
}

/**
 * Checks if a node has any variable bindings matching the given ID
 */
function checkNodeBindings(node: SceneNode, variableId: string): boolean {
  try {
    if (!('boundVariables' in node) || !node.boundVariables) return false;

    const boundVars = node.boundVariables as Record<string, VariableBinding | VariableBinding[]>;
    
    return Object.keys(boundVars).some((property: string) => {
      const binding = boundVars[property];
      if (!binding) return false;

      const bindings = Array.isArray(binding) ? binding : [binding];
      return bindings.some(b => b?.id === variableId);
    });
  } catch (error) {
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
async function processBatch(nodes: SceneNode[], stats: ProcessingStats): Promise<Set<string>> {
  const usedIds = new Set<string>();
  
  for (const node of nodes) {
    stats.nodesProcessed++;
    
    try {
      // Check for bound variables
      if ('boundVariables' in node && node.boundVariables) {
        const boundVars = node.boundVariables as Record<string, VariableBinding | VariableBinding[]>;
        
        for (const [property, binding] of Object.entries(boundVars)) {
          try {
            if (!binding) continue;
            
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
          } catch (bindingError) {
            console.warn(`⚠️ Error processing binding for property ${property} on node ${node.name}:`, bindingError);
          }
        }
      }

      // Check for style references
      if ('styles' in node) {
        const styles = (node as any).styles;
        if (styles && typeof styles === 'object') {
          for (const [styleKey, styleValue] of Object.entries(styles)) {
            try {
              const style = figma.getStyleById(styleValue as string);
              if (style?.boundVariables) {
                Object.values(style.boundVariables).forEach(binding => {
                  const bindings = Array.isArray(binding) ? binding : [binding];
                  bindings.forEach(b => {
                    if (b?.type === 'VARIABLE_ALIAS' && typeof b.id === 'string') {
                      usedIds.add(b.id);
                      stats.variablesFound++;
                    }
                  });
                });
              }
            } catch (styleError) {
              console.warn(`⚠️ Error processing style ${styleKey}:`, styleError);
            }
          }
        }
      }
    } catch (error) {
      console.error(`❌ Failed to process node ${node.name}:`, error);
      continue;
    }
  }
  
  return usedIds;
}

/**
 * Encontra variáveis não utilizadas com suporte a cache e filtros
 */
async function findUnusedVariables(options: FilterOptions = {
  types: new Set(),
  collections: new Set(),
  modes: new Set()
}): Promise<VariableResult[]> {
  console.log('🔍 Iniciando busca de variáveis não utilizadas...');
  
  try {
    // Limpar cache expirado
    cleanExpiredCache();
    
    // Obter todas as variáveis
    const allVariables = figma.variables.getLocalVariables();
    console.log(`📊 Total de variáveis: ${allVariables.length}`);
    
    // Aplicar filtros iniciais
    const filteredVariables = await filterVariables(allVariables, options);
    console.log(`📊 Variáveis após filtros: ${filteredVariables.length}`);
    
    // Verificar uso de cada variável (usando cache)
    const unusedVariables: VariableResult[] = [];
    let analyzed = 0;
    
    for (const variable of filteredVariables) {
      analyzed++;
      updateStatus({ analyzed });
      
      if (variable.isDeleted) {
        console.log(`⏭️ Ignorando variável deletada: ${variable.name}`);
        continue;
      }
      
      // Verificar no cache
      const status = await getCachedVariableStatus(variable);
      
      if (!status.isUsed) {
        const collection = figma.variables.getVariableCollectionById(variable.variableCollectionId);
        unusedVariables.push({
          name: variable.name,
          collection: collection?.name || '[unknown-collection]',
          id: variable.id
        });
        
        console.log(`🎯 Variável não utilizada encontrada: ${variable.name} (${variable.id})`);
        console.log(`   Tipo: ${status.resolvedType}`);
        if (status.usageLocations.length > 0) {
          console.log('   Últimos locais de uso:', status.usageLocations);
        }
      }
    }
    
    // Atualizar estatísticas
    updateStatus({
      total: allVariables.length,
      analyzed,
      unused: unusedVariables.length
    });
    
    return unusedVariables;
    
  } catch (error) {
    console.error('❌ Erro ao buscar variáveis:', error);
    throw new Error(`Falha na busca: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
  }
}

/**
 * Creates a text node with the analysis results and shows a success toast
 */
async function createTextNode(unusedVars: VariableResult[]): Promise<TextNode | null> {
  try {
    const text = figma.createText();
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });

    if (unusedVars.length === 0) {
      text.characters = "✅ No unused variables found!";
      figma.notify("✅ No unused variables found!");
    } else {
      const byCollection: { [key: string]: VariableResult[] } = {};
      unusedVars.forEach(v => {
        if (!byCollection[v.collection]) byCollection[v.collection] = [];
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
  } catch (error) {
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
        console.log('🚀 Inicializando plugin...');
        
        const collections = figma.variables.getLocalVariableCollections();
        console.log(`📚 Collections encontradas: ${collections.length}`);
        
        if (!collections || collections.length === 0) {
          console.log('⚠️ Nenhuma collection encontrada');
          figma.notify('Nenhuma collection de variáveis encontrada');
          figma.ui.postMessage({ 
            type: 'collections',
            collections: []
          });
          return;
        }
        
        const mappedCollections = collections.map(collection => {
          console.log(`📝 Processando collection: ${collection.name} (${collection.id})`);
          return {
            id: collection.id,
            name: collection.name,
            variableIds: collection.variableIds
          };
        });
        
        figma.ui.postMessage({ 
          type: 'collections',
          collections: mappedCollections
        });
        
      } catch (error) {
        console.error('❌ Erro durante a inicialização:', error);
        figma.notify('Erro ao inicializar o plugin', { error: true });
        figma.ui.postMessage({ 
          type: 'error',
          message: error instanceof Error ? error.message : 'Erro desconhecido'
        });
      }
      break;

    case 'get-variable-types':
      try {
        const variables = figma.variables.getLocalVariables();
        const types = new Set(variables.map(v => v.resolvedType));
        
        figma.ui.postMessage({
          type: 'variable-types',
          types: Array.from(types)
        });
      } catch (error) {
        console.error('❌ Erro ao obter tipos:', error);
      }
      break;

    case 'clear-cache':
      try {
        variableCache.clear();
        figma.notify('✨ Cache limpo com sucesso');
      } catch (error) {
        console.error('❌ Erro ao limpar cache:', error);
        figma.notify('Erro ao limpar cache', { error: true });
      }
      break;

    case 'print-unused':
      try {
        const unusedVariables = await findUnusedVariables([]);
        const textNode = await createTextNode(unusedVariables);
        if (textNode) {
          figma.viewport.scrollAndZoomIntoView([textNode]);
        }
      } catch (error) {
        figma.notify('Failed to print unused variables');
      }
      break;

    case 'delete-variables':
      try {
        console.log('🗑️ Iniciando exclusão de variáveis:', msg);
        
        if (!msg.variables?.length) {
          throw new Error('Nenhuma variável para excluir');
        }

        // Processar cada variável do array
        for (const variable of msg.variables) {
          try {
            console.log(`\n🔍 Processando variável:`, variable);
            
            // Obter a variável usando o ID
            const variableToDelete = figma.variables.getVariableById(variable.id);
            
            if (!variableToDelete) {
              throw new Error(`Variável não encontrada: ${variable.name} (${variable.id})`);
            }
            
            console.log(`🗑️ Excluindo variável: ${variableToDelete.name}`);
            
            // Tentar excluir
            await variableToDelete.remove();
            
            // Verificar se foi excluída
            await new Promise(resolve => setTimeout(resolve, 500));
            const stillExists = figma.variables.getVariableById(variable.id);
            
            if (stillExists) {
              throw new Error(`Falha ao excluir variável ${variable.name}`);
            }
            
            console.log(`✅ Variável excluída com sucesso: ${variable.name}`);
          } catch (error) {
            console.error(`❌ Erro ao excluir variável:`, error);
            throw error;
          }
        }
        
        // Enviar resposta de sucesso
        figma.ui.postMessage({ 
          type: 'delete-result',
          success: true,
          stats: {
            total: msg.variables.length,
            success: msg.variables.length,
            errors: 0
          }
        });
        
        figma.notify(`✅ ${msg.variables.length} ${msg.variables.length === 1 ? 'variável excluída' : 'variáveis excluídas'} com sucesso`);
        
      } catch (error) {
        console.error('❌ Erro durante exclusão:', error);
        figma.ui.postMessage({ 
          type: 'delete-result',
          success: false,
          error: error instanceof Error ? error.message : 'Erro desconhecido'
        });
        figma.notify('Erro ao excluir variáveis', { error: true });
      }
      break;

    case 'close':
      figma.closePlugin();
      break;

    case 'map-design-variables':
      try {
        console.log('🎨 Iniciando mapeamento de variáveis de design...');
        const designMap = await mapDesignVariables();
        
        // Enviar resultados para a UI
        figma.ui.postMessage({
          type: 'design-variables-mapped',
          data: {
            colors: Array.from(designMap.colors.entries()),
            typography: Array.from(designMap.typography.entries()),
            effects: Array.from(designMap.effects.entries()),
            other: Array.from(designMap.other.entries())
          }
        });

        // Executar limpeza de coleções
        await cleanupCollections(designMap);
        
        figma.notify('✨ Mapeamento de variáveis concluído');
      } catch (error) {
        console.error('❌ Erro durante mapeamento:', error);
        figma.notify('Erro ao mapear variáveis', { error: true });
      }
      break;

    case 'variableschanged':
      try {
        const designMap = await mapDesignVariables();
        updateStatus({
          total: designMap.colors.size + designMap.typography.size + designMap.effects.size + designMap.other.size
        });
      } catch (error) {
        console.error('❌ Erro ao atualizar status:', error);
      }
      break;
  }
};

// Função auxiliar para verificar referências de forma mais robusta
async function checkVariableReferences(variable: Variable): Promise<boolean> {
  try {
    const collections = figma.variables.getLocalVariableCollections();
    
    // Verificar referências em outras variáveis
    for (const collection of collections) {
      for (const varId of collection.variableIds) {
        if (varId === variable.id) continue;
        
        const var2 = figma.variables.getVariableById(varId);
        if (!var2) continue;

        // Verificar todas as referências em todos os modos
        for (const [modeId, value] of Object.entries(var2.valuesByMode)) {
          if (typeof value === 'object' && value !== null) {
            const valueObj = value as any;
            // Comparar os IDs limpos (sem o prefixo VariableID:)
            if (valueObj.type === 'VARIABLE_ALIAS' && 
                valueObj.id.replace(/^VariableID:/, '') === variable.id) {
              console.log(`🔗 Variable ${variable.name} is referenced by ${var2.name}`);
              return true;
            }
          }
        }
      }
    }

    // Verificar referências em componentes e instâncias
    for (const page of figma.root.children) {
      const hasReferences = await checkNodeForReferences(page, variable.id);
      if (hasReferences) {
        console.log(`🔗 Variable ${variable.name} is referenced in page ${page.name}`);
        return true;
      }
    }

    console.log(`✨ Variable ${variable.name} has no references`);
    return false;
  } catch (error) {
    console.error('❌ Error checking variable references:', error);
    return true; // Em caso de erro, assumir que há referências por segurança
  }
}

// Função auxiliar para verificar referências em nós
async function checkNodeForReferences(node: BaseNode, variableId: string): Promise<boolean> {
  try {
    // Verificar se o nó tem variáveis vinculadas
    if ('boundVariables' in node) {
      const boundVars = (node as any).boundVariables;
      if (boundVars) {
        for (const prop in boundVars) {
          const binding = boundVars[prop];
          if (Array.isArray(binding)) {
            for (const b of binding) {
              // Comparar os IDs limpos
              if (b?.type === 'VARIABLE_ALIAS' && 
                  b.id.replace(/^VariableID:/, '') === variableId) {
                console.log(`🔗 Found reference in node ${node.name} (${node.type})`);
                return true;
              }
            }
          } else if (binding?.type === 'VARIABLE_ALIAS' && 
                     binding.id.replace(/^VariableID:/, '') === variableId) {
            console.log(`�� Found reference in node ${node.name} (${node.type})`);
            return true;
          }
        }
      }
    }

    // Verificar filhos recursivamente
    if ('children' in node) {
      for (const child of (node as any).children) {
        const hasReferences = await checkNodeForReferences(child, variableId);
        if (hasReferences) return true;
      }
    }

    return false;
  } catch (error) {
    console.error(`❌ Error checking node ${node.name} for references:`, error);
    return false;
  }
}

/**
 * Verifica todas as vinculações de variáveis em elementos de design
 * @returns Set com os IDs das variáveis em uso
 */
async function getActiveVariableReferences(): Promise<Set<string>> {
  const usedVariableIds = new Set<string>();
  const propertiesToCheck = ['fills', 'strokes', 'effects', 'textStyleId'];

  const processNode = async (node: SceneNode) => {
    try {
      // Verificar cada propriedade que pode ter variáveis vinculadas
      for (const prop of propertiesToCheck) {
        try {
          const boundVariable = node.getBoundVariable(prop as VariableBindableType);
          if (boundVariable) {
            const varId = boundVariable.id;
            usedVariableIds.add(varId);
            usedVariableIds.add(varId.replace(/^VariableID:/, '')); // Versão sem prefixo
            console.log(`🔗 Variável vinculada encontrada:
              Nó: ${node.name}
              Propriedade: ${prop}
              ID: ${varId}
            `);
          }
        } catch (propError) {
          // Algumas propriedades podem não estar disponíveis em todos os tipos de nós
          continue;
        }
      }

      // Verificar propriedades específicas de texto
      if (node.type === 'TEXT') {
        const textNode = node as TextNode;
        try {
          const textStyleVariable = textNode.getBoundVariable('textStyleId');
          if (textStyleVariable) {
            usedVariableIds.add(textStyleVariable.id);
            usedVariableIds.add(textStyleVariable.id.replace(/^VariableID:/, ''));
          }
        } catch (textError) {
          console.warn(`⚠️ Erro ao verificar estilo de texto em ${node.name}:`, textError);
        }
      }

      // Verificar filhos recursivamente
      if ('children' in node) {
        for (const child of node.children) {
          await processNode(child as SceneNode);
        }
      }

    } catch (nodeError) {
      console.warn(`⚠️ Erro ao processar nó ${node.name}:`, nodeError);
    }
  };

  // Processar todas as páginas
  console.log('�� Iniciando verificação de variáveis vinculadas...');
  for (const page of figma.root.children) {
    console.log(`\n📄 Verificando página: ${page.name}`);
    for (const node of page.children) {
      await processNode(node as SceneNode);
    }
  }

  // Comparar com todas as variáveis locais
  const allVariables = figma.variables.getLocalVariables();
  console.log(`\n📊 Resumo:
    Total de variáveis: ${allVariables.length}
    Variáveis em uso: ${usedVariableIds.size}
    Variáveis não utilizadas: ${allVariables.length - usedVariableIds.size}
  `);

  return usedVariableIds;
}

/**
 * Filtra variáveis não utilizadas comparando com o Set de IDs em uso
 * @param usedIds Set com os IDs das variáveis em uso
 * @returns Array com as variáveis não utilizadas
 */
async function filterUnusedVariables(usedIds: Set<string>): Promise<Variable[]> {
  console.log('🔍 Iniciando filtragem de variáveis não utilizadas...');
  
  try {
    const allVariables = figma.variables.getLocalVariables();
    updateStatus({ total: allVariables.length });
    
    let analyzed = 0;
    let unused = 0;
    
    const unusedVariables = allVariables.filter(variable => {
      analyzed++;
      updateStatus({ analyzed });
      
      if (variable.isDeleted) {
        console.log(`⏭️ Ignorando variável deletada: ${variable.name}`);
        return false;
      }
      
      const originalId = variable.id;
      const cleanId = variable.id.replace(/^VariableID:/, '');
      const isUsed = usedIds.has(originalId) || usedIds.has(cleanId);
      
      if (!isUsed) {
        unused++;
        updateStatus({ unused });
        console.log(`🎯 Variável não utilizada encontrada: ${variable.name} (${originalId})`);
      }
      
      return !isUsed;
    });
    
    return unusedVariables;
    
  } catch (error) {
    console.error('❌ Erro ao filtrar variáveis:', error);
    throw new Error(`Falha ao filtrar variáveis: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
  }
}

// Interfaces para mapeamento de variáveis de design
interface DesignVariableMap {
  colors: Map<string, VariableInfo>;
  typography: Map<string, VariableInfo>;
  effects: Map<string, VariableInfo>;
  other: Map<string, VariableInfo>;
}

interface VariableUsageMap {
  nodeId: string;
  nodeName: string;
  properties: string[];
  modeId?: string;
}

/**
 * Mapeia todas as variáveis de design do documento
 * @returns Mapa organizado de variáveis por tipo
 */
async function mapDesignVariables(): Promise<DesignVariableMap> {
  console.log('🎨 Iniciando mapeamento de variáveis de design...');
  
  const designMap: DesignVariableMap = {
    colors: new Map(),
    typography: new Map(),
    effects: new Map(),
    other: new Map()
  };

  try {
    // Obter todas as coleções e seus modos
    const collections = figma.variables.getLocalVariableCollections();
    console.log(`📚 Encontradas ${collections.length} coleções`);

    for (const collection of collections) {
      console.log(`\n🗂️ Processando coleção: ${collection.name}`);
      
      // Processar cada variável na coleção
      for (const varId of collection.variableIds) {
        const variable = figma.variables.getVariableById(varId);
        if (!variable) continue;

        // Criar informações estendidas da variável
        const varInfo: VariableInfo = {
          ...variable,
          usages: [],
          collectionName: collection.name,
          modes: {}
        };

        // Processar valores em diferentes modos
        Object.entries(variable.valuesByMode).forEach(([modeId, value]) => {
          varInfo.modes[modeId] = {
            value,
            references: []
          };

          // Verificar referências em outros modos
          if (typeof value === 'object' && value !== null && 'type' in value) {
            if (value.type === 'VARIABLE_ALIAS') {
              varInfo.modes[modeId].references.push(value.id);
            }
          }
        });

        // Categorizar variável baseado no tipo
        if (variable.resolvedType === 'COLOR') {
          designMap.colors.set(variable.id, varInfo);
        } else if (variable.resolvedType === 'FLOAT' && variable.scopes.includes('TEXT')) {
          designMap.typography.set(variable.id, varInfo);
        } else if (variable.resolvedType === 'EFFECT') {
          designMap.effects.set(variable.id, varInfo);
        } else {
          designMap.other.set(variable.id, varInfo);
        }
      }
    }

    // Mapear uso em componentes e instâncias
    await mapComponentUsage(designMap);

    // Gerar relatório
    console.log('\n📊 Relatório de Variáveis:');
    console.log(`Cores: ${designMap.colors.size}`);
    console.log(`Tipografia: ${designMap.typography.size}`);
    console.log(`Efeitos: ${designMap.effects.size}`);
    console.log(`Outros: ${designMap.other.size}`);

    return designMap;

  } catch (error) {
    console.error('❌ Erro ao mapear variáveis:', error);
    throw new Error(`Falha ao mapear variáveis: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
  }
}

/**
 * Mapeia o uso de variáveis em componentes e instâncias
 */
async function mapComponentUsage(designMap: DesignVariableMap): Promise<void> {
  console.log('\n🔍 Mapeando uso em componentes...');

  const processNode = async (node: SceneNode) => {
    try {
      // Verificar variáveis vinculadas
      if ('boundVariables' in node) {
        const boundVars = node.boundVariables as Record<string, VariableBinding | VariableBinding[]>;
        
        for (const [property, binding] of Object.entries(boundVars)) {
          const bindings = Array.isArray(binding) ? binding : [binding];
          
          for (const b of bindings) {
            if (b?.type === 'VARIABLE_ALIAS' && b.id) {
              // Registrar uso da variável
              const usage: VariableUsageMap = {
                nodeId: node.id,
                nodeName: node.name,
                properties: [property]
              };

              // Adicionar à categoria apropriada
              for (const [category, map] of Object.entries(designMap)) {
                if (map.has(b.id)) {
                  const varInfo = map.get(b.id);
                  if (varInfo) {
                    varInfo.usages.push(usage);
                  }
                }
              }
            }
          }
        }
      }

      // Processar filhos recursivamente
      if ('children' in node) {
        for (const child of node.children) {
          await processNode(child as SceneNode);
        }
      }
    } catch (error) {
      console.warn(`⚠️ Erro ao processar nó ${node.name}:`, error);
    }
  };

  // Processar todas as páginas
  for (const page of figma.root.children) {
    console.log(`📄 Processando página: ${page.name}`);
    for (const node of page.children) {
      await processNode(node as SceneNode);
    }
  }
}

/**
 * Remove coleções vazias e limpa referências quebradas
 */
async function cleanupCollections(designMap: DesignVariableMap): Promise<void> {
  console.log('\n🧹 Iniciando limpeza de coleções...');
  
  try {
    const collections = figma.variables.getLocalVariableCollections();
    
    for (const collection of collections) {
      console.log(`\n🗂️ Verificando coleção: ${collection.name}`);
      
      // Verificar se a coleção está vazia
      if (collection.variableIds.length === 0) {
        console.log(`🗑️ Removendo coleção vazia: ${collection.name}`);
        collection.remove();
        continue;
      }

      // Verificar variáveis com referências quebradas
      let hasValidVariables = false;
      for (const varId of collection.variableIds) {
        const variable = figma.variables.getVariableById(varId);
        if (!variable) continue;

        // Verificar referências em todos os modos
        for (const [modeId, value] of Object.entries(variable.valuesByMode)) {
          if (typeof value === 'object' && value !== null && 'type' in value) {
            if (value.type === 'VARIABLE_ALIAS') {
              const referencedVar = figma.variables.getVariableById(value.id);
              if (!referencedVar) {
                console.log(`⚠️ Referência quebrada encontrada em ${variable.name}`);
                // Limpar referência quebrada
                variable.valuesByMode[modeId] = null;
              }
            }
          }
          if (value !== null) hasValidVariables = true;
        }
      }

      // Remover coleção se não tiver variáveis válidas
      if (!hasValidVariables) {
        console.log(`🗑️ Removendo coleção sem variáveis válidas: ${collection.name}`);
        collection.remove();
      }
    }

    console.log('✨ Limpeza de coleções concluída');
    
  } catch (error) {
    console.error('❌ Erro durante limpeza:', error);
    throw new Error(`Falha na limpeza: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
  }
}

// Sistema de Cache para Verificações
interface VariableCache {
  lastCheck: number;
  isUsed: boolean;
  usageLocations: string[];
  resolvedType: string;
}

interface FilterOptions {
  types: Set<string>;
  collections: Set<string>;
  modes: Set<string>;
}

// Cache global com tempo de expiração de 5 minutos
const CACHE_EXPIRATION = 5 * 60 * 1000; // 5 minutos em ms
const variableCache = new Map<string, VariableCache>();

/**
 * Verifica e limpa cache expirado
 */
function cleanExpiredCache(): void {
  const now = Date.now();
  for (const [id, data] of variableCache.entries()) {
    if (now - data.lastCheck > CACHE_EXPIRATION) {
      variableCache.delete(id);
    }
  }
}

/**
 * Obtém resultado do cache ou executa verificação
 */
async function getCachedVariableStatus(variable: Variable): Promise<VariableCache> {
  const cached = variableCache.get(variable.id);
  const now = Date.now();

  if (cached && (now - cached.lastCheck < CACHE_EXPIRATION)) {
    return cached;
  }

  // Executar verificação
  const isUsed = await checkVariableReferences(variable);
  const usageLocations = await findUsageLocations(variable);
  
  const cacheEntry: VariableCache = {
    lastCheck: now,
    isUsed,
    usageLocations,
    resolvedType: variable.resolvedType
  };

  variableCache.set(variable.id, cacheEntry);
  return cacheEntry;
}

/**
 * Encontra locais onde a variável é usada
 */
async function findUsageLocations(variable: Variable): Promise<string[]> {
  const locations: string[] = [];
  
  for (const page of figma.root.children) {
    const processNode = async (node: SceneNode) => {
      if ('boundVariables' in node) {
        const boundVars = node.boundVariables as Record<string, VariableBinding | VariableBinding[]>;
        
        for (const [property, binding] of Object.entries(boundVars)) {
          const bindings = Array.isArray(binding) ? binding : [binding];
          
          for (const b of bindings) {
            if (b?.type === 'VARIABLE_ALIAS' && b.id === variable.id) {
              locations.push(`${page.name} > ${node.name} (${property})`);
            }
          }
        }
      }

      if ('children' in node) {
        for (const child of node.children) {
          await processNode(child as SceneNode);
        }
      }
    };

    for (const node of page.children) {
      await processNode(node as SceneNode);
    }
  }

  return locations;
}

/**
 * Filtra variáveis com base nas opções selecionadas
 */
async function filterVariables(variables: Variable[], options: FilterOptions): Promise<Variable[]> {
  return variables.filter(v => {
    // Filtrar por tipo
    if (options.types.size > 0 && !options.types.has(v.resolvedType)) {
      return false;
    }

    // Filtrar por coleção
    const collection = figma.variables.getVariableCollectionById(v.variableCollectionId);
    if (options.collections.size > 0 && !options.collections.has(collection?.name || '')) {
      return false;
    }

    // Filtrar por modo
    if (options.modes.size > 0) {
      const hasSelectedMode = Object.keys(v.valuesByMode).some(mode => 
        options.modes.has(mode)
      );
      if (!hasSelectedMode) return false;
    }

    return true;
  });
}

// Interfaces para backup e rollback
interface VariableBackup {
  id: string;
  name: string;
  collection: string;
  valuesByMode: Record<string, any>;
  resolvedType: string;
  scopes: string[];
}

interface DeleteOperation {
  variable: Variable;
  backup: VariableBackup;
  retryCount: number;
  status: 'pending' | 'success' | 'error';
  error?: string;
}

interface BatchDeleteResult {
  success: boolean;
  deletedCount: number;
  errors: Array<{
    variable: string;
    error: string;
  }>;
  backups: VariableBackup[];
}

const DELETE_CONFIG = {
  maxRetries: 3,
  retryDelay: 1000,
  timeout: 5000,
  batchSize: 10
} as const;

/**
 * Cria um backup de uma variável antes da exclusão
 */
async function backupVariable(variable: Variable): Promise<VariableBackup> {
  try {
    console.log(`📦 Criando backup para variável: ${variable.name}`);
    
    const collection = figma.variables.getVariableCollectionById(variable.variableCollectionId);
    if (!collection) {
      console.warn(`⚠️ Collection não encontrada para variável: ${variable.name}`);
    }
    
    const backup: VariableBackup = {
      id: variable.id,
      name: variable.name,
      collection: collection?.name || '[unknown-collection]',
      valuesByMode: {},
      resolvedType: variable.resolvedType,
      scopes: [...variable.scopes]
    };
    
    // Fazer cópia profunda dos valores por modo
    for (const [modeId, value] of Object.entries(variable.valuesByMode)) {
      backup.valuesByMode[modeId] = JSON.parse(JSON.stringify(value));
    }
    
    console.log(`✅ Backup criado com sucesso para: ${variable.name}`);
    return backup;
    
  } catch (error) {
    console.error(`❌ Erro ao criar backup para ${variable.name}:`, error);
    throw new Error(`Falha ao criar backup: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
  }
}

/**
 * Restaura uma variável a partir do backup
 */
async function restoreVariable(backup: VariableBackup): Promise<boolean> {
  try {
    console.log(`🔄 Restaurando variável: ${backup.name}`);
    
    // Encontrar ou criar coleção
    let collection = figma.variables.getLocalVariableCollections()
      .find(c => c.name === backup.collection);
    
    if (!collection) {
      collection = figma.variables.createVariableCollection(backup.collection);
    }
    
    // Criar nova variável
    const restored = figma.variables.createVariable(
      backup.name,
      collection.id,
      backup.resolvedType
    );
    
    // Restaurar valores por modo
    Object.entries(backup.valuesByMode).forEach(([modeId, value]) => {
      restored.setValueForMode(modeId, value);
    });
    
    // Restaurar escopos
    restored.scopes = backup.scopes;
    
    console.log(`✅ Variável restaurada com sucesso: ${backup.name}`);
    return true;
    
  } catch (error) {
    console.error(`❌ Erro ao restaurar variável ${backup.name}:`, error);
    return false;
  }
}

/**
 * Tenta excluir uma variável com retry e timeout
 */
async function deleteVariableWithRetry(operation: DeleteOperation): Promise<boolean> {
  const { variable, retryCount } = operation;
  
  if (retryCount >= DELETE_CONFIG.maxRetries) {
    operation.status = 'error';
    operation.error = `Número máximo de tentativas excedido (${DELETE_CONFIG.maxRetries})`;
    return false;
  }
  
  try {
    console.log(`🗑️ Tentativa ${retryCount + 1} de excluir: ${variable.name}`);
    
    // Criar Promise com timeout
    const deletePromise = new Promise<boolean>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Timeout ao excluir ${variable.name}`));
      }, DELETE_CONFIG.timeout);
      
      try {
        variable.remove();
        
        // Verificar se foi realmente excluída
        setTimeout(() => {
          const stillExists = figma.variables.getVariableById(variable.id);
          if (stillExists) {
            reject(new Error('Variável ainda existe após exclusão'));
          } else {
            clearTimeout(timeoutId);
            resolve(true);
          }
        }, 100);
        
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
    
    await deletePromise;
    operation.status = 'success';
    return true;
    
  } catch (error) {
    console.warn(`⚠️ Erro ao excluir ${variable.name}:`, error);
    operation.retryCount++;
    
    // Aguardar antes de retry
    await new Promise(resolve => setTimeout(resolve, DELETE_CONFIG.retryDelay));
    return deleteVariableWithRetry(operation);
  }
}

/**
 * Exclui variáveis em lote com suporte a backup e rollback
 */
async function batchDeleteVariables(variableIds: string[]): Promise<BatchDeleteResult> {
  console.log('\n🔍 Iniciando exclusão em lote...');
  console.log('IDs recebidos:', variableIds);
  
  const result: BatchDeleteResult = {
    success: false,
    deletedCount: 0,
    errors: [],
    backups: []
  };
  
  try {
    // Validar entrada
    if (!variableIds?.length) {
      throw new Error('Nenhuma variável para excluir');
    }

    // Primeiro, vamos validar todas as variáveis e seus usos
    const validationResult = await validateVariables(variableIds);
    console.log('📊 Resultado da validação:', validationResult);

    // Processar cada variável
    for (const id of variableIds) {
      try {
        console.log(`\n🔍 Procurando variável com ID: ${id}`);
        
        // Tentar obter a variável com diferentes formatos de ID
        let variable = null;
        const possibleIds = [
          id,
          `VariableID:${id}`,
          id.replace(/^VariableID:/, '')
        ];
        
        for (const possibleId of possibleIds) {
          console.log(`  Tentando ID: ${possibleId}`);
          variable = figma.variables.getVariableById(possibleId);
          if (variable) {
            console.log(`  ✅ Variável encontrada: ${variable.name} (${variable.id})`);
            break;
          }
        }
        
        if (!variable) {
          throw new Error(`Variável não encontrada com nenhum formato de ID: ${id}`);
        }

        // Verificar se a variável está sendo usada
        const variableUsage = validationResult.appliedVariablesMap[variable.id];
        if (variableUsage) {
          console.log(`⚠️ Variável ${variable.name} está em uso:`, variableUsage);
          throw new Error(`Variável ${variable.name} está em uso e não pode ser excluída`);
        }
        
        // Verificar se a variável pode ser excluída
        if (!variable.remove) {
          throw new Error(`Variável ${variable.name} não pode ser excluída (método remove não disponível)`);
        }
        
        // Fazer backup
        console.log(`  📦 Criando backup para: ${variable.name}`);
        const backup = await backupVariable(variable);
        result.backups.push(backup);
        
        try {
          // Tentar excluir
          console.log(`  🗑️ Excluindo variável: ${variable.name}`);
          await variable.remove();
          
          // Aguardar um momento para garantir que a exclusão foi processada
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Verificar se foi realmente excluída
          const stillExists = figma.variables.getVariableById(variable.id);
          if (stillExists) {
            throw new Error('Variável ainda existe após tentativa de exclusão');
          }
          
          console.log(`  ✅ Variável excluída com sucesso: ${variable.name}`);
          result.deletedCount++;
          
        } catch (removeError) {
          console.error(`  ❌ Erro ao excluir variável:`, removeError);
          throw new Error(`Falha ao excluir: ${removeError instanceof Error ? removeError.message : 'Erro desconhecido'}`);
        }
        
      } catch (error) {
        console.error(`❌ Erro ao processar variável ${id}:`, error);
        result.errors.push({
          variable: id,
          error: error instanceof Error ? error.message : 'Erro desconhecido'
        });
      }
    }
    
    result.success = result.deletedCount > 0;
    console.log('\n📊 Resultado da exclusão:', result);
    return result;
    
  } catch (error) {
    console.error('\n❌ Erro durante exclusão em lote:', error);
    throw error;
  }
}

interface ValidationResult {
  appliedVariablesMap: { [key: string]: VariableUsage[] };
  appliedVariablesArray: Array<{
    id: string;
    objects: Array<{
      id: string;
      name: string;
      type: string;
    }>;
    properties: string[];
  }>;
  summary: {
    totalVariablesAssigned: number;
    totalVariablesMissing: number;
    totalVariables: number;
    totalChecks: number;
    totalSuccesses: number;
  };
}

async function validateVariables(variableIds: string[]): Promise<ValidationResult> {
  console.log('🔍 Validando variáveis:', variableIds);
  
  const result: ValidationResult = {
    appliedVariablesMap: {},
    appliedVariablesArray: [],
    summary: {
      totalVariablesAssigned: 0,
      totalVariablesMissing: 0,
      totalVariables: variableIds.length,
      totalChecks: 0,
      totalSuccesses: 0
    }
  };

  // Função auxiliar para processar um nó
  const processNode = async (node: SceneNode) => {
    result.summary.totalChecks++;
    
    try {
      if ('boundVariables' in node) {
        const boundVars = node.boundVariables as Record<string, VariableBinding | VariableBinding[]>;
        
        for (const [property, binding] of Object.entries(boundVars)) {
          const bindings = Array.isArray(binding) ? binding : [binding];
          
          for (const b of bindings) {
            if (b?.type === 'VARIABLE_ALIAS' && b.id) {
              // Registrar uso da variável
              if (!result.appliedVariablesMap[b.id]) {
                result.appliedVariablesMap[b.id] = [];
              }
              
              result.appliedVariablesMap[b.id].push({
                node: node,
                property: property
              });

              // Adicionar ao array de variáveis aplicadas
              let appliedVar = result.appliedVariablesArray.find(v => v.id === b.id);
              if (!appliedVar) {
                appliedVar = {
                  id: b.id,
                  objects: [],
                  properties: []
                };
                result.appliedVariablesArray.push(appliedVar);
              }

              appliedVar.objects.push({
                id: node.id,
                name: node.name,
                type: node.type
              });

              if (!appliedVar.properties.includes(property)) {
                appliedVar.properties.push(property);
              }

              result.summary.totalVariablesAssigned++;
              result.summary.totalSuccesses++;
            }
          }
        }
      }

      // Processar filhos recursivamente
      if ('children' in node) {
        for (const child of node.children) {
          await processNode(child as SceneNode);
        }
      }
    } catch (error) {
      console.warn(`⚠️ Erro ao processar nó ${node.name}:`, error);
    }
  };

  // Processar todas as páginas
  for (const page of figma.root.children) {
    console.log(`📄 Processando página: ${page.name}`);
    for (const node of page.children) {
      await processNode(node as SceneNode);
    }
  }

  // Contar variáveis não encontradas
  result.summary.totalVariablesMissing = variableIds.length - Object.keys(result.appliedVariablesMap).length;

  console.log('✅ Validação concluída:', result);
  return result;
}