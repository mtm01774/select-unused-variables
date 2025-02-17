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
            scopes: v.scopes || []
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
 * Finds all unused variables in the document using batch processing
 */
async function findUnusedVariables(selectedCollections: string[] = []): Promise<VariableResult[]> {
  try {
    console.log('🔍 Iniciando pesquisa de variáveis...');
    
    // Obter todas as variáveis
    const allVariables = await getAllVariables(selectedCollections);
    console.log(`📊 Total de variáveis encontradas: ${allVariables.length}`);
    
    // Set para armazenar IDs de variáveis em uso (tanto com quanto sem prefixo)
    const usedVarIds = new Set<string>();
    
    // Verificar uso em todas as páginas
    for (const page of figma.root.children) {
      console.log(`\n📄 Analisando página: ${page.name}`);
      
      const processNode = async (node: SceneNode) => {
        try {
          // Verificar variáveis vinculadas
          if ('boundVariables' in node && node.boundVariables) {
            const boundVars = node.boundVariables as Record<string, VariableBinding | VariableBinding[]>;
            
            for (const [property, binding] of Object.entries(boundVars)) {
              const bindings = Array.isArray(binding) ? binding : [binding];
              
              for (const b of bindings) {
                if (b?.type === 'VARIABLE_ALIAS' && b.id) {
                  // Armazenar tanto o ID original quanto o ID limpo
                  const originalId = b.id;
                  const cleanId = b.id.replace(/^VariableID:/, '');
                  
                  usedVarIds.add(originalId);
                  usedVarIds.add(cleanId);
                  
                  console.log(`🔗 Variável em uso:
                    Nó: ${node.name}
                    Propriedade: ${property}
                    ID Original: ${originalId}
                    ID Limpo: ${cleanId}
                  `);
                }
              }
            }
          }
          
          // Verificar filhos recursivamente
          if ('children' in node) {
            for (const child of node.children) {
              await processNode(child as SceneNode);
            }
          }
        } catch (error) {
          console.warn(`⚠️ Erro ao processar nó ${node.name}:`, error);
        }
      };
      
      // Processar todos os nós da página
      for (const node of page.children) {
        await processNode(node as SceneNode);
      }
    }
    
    // Filtrar variáveis não utilizadas
    const unusedVars = allVariables.filter(v => {
      const originalId = v.id;
      const cleanId = v.id.replace(/^VariableID:/, '');
      const isUsed = usedVarIds.has(originalId) || usedVarIds.has(cleanId);
      
      console.log(`\n📝 Verificando variável: ${v.name}
        ID Original: ${originalId}
        ID Limpo: ${cleanId}
        Em uso: ${isUsed}
      `);
      
      return !isUsed;
    });
    
    // Log do resultado final
    console.log('\n📊 Resultado da análise:', {
      totalVariables: allVariables.length,
      usedVariables: usedVarIds.size,
      unusedVariables: unusedVars.length,
      usedIds: Array.from(usedVarIds)
    });
    
    return unusedVars.map(v => ({
      name: v.name,
      collection: v.collection,
      id: v.id
    }));
    
  } catch (error) {
    console.error('❌ Erro ao procurar variáveis não utilizadas:', error);
    throw new Error(`Falha ao procurar variáveis não utilizadas: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
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
      } catch (error) {
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
      } catch (error) {
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
      } catch (error) {
        figma.notify('Failed to print unused variables');
      }
      break;

    case 'delete-variables':
      try {
        const { variableIds } = msg;
        console.log('\n🔍 Iniciando processo de exclusão em lote...');
        console.log('IDs recebidos:', variableIds);

        if (!variableIds?.length) {
          throw new Error('Nenhuma variável para excluir');
        }

        let successCount = 0;
        const errors: string[] = [];

        for (const id of variableIds) {
          try {
            console.log(`\n🔍 Processando variável ${id}...`);
            
            // Tentar encontrar a variável (com prefixo ou sem)
            const cleanId = id.replace(/^VariableID:/, '');
            console.log('ID limpo:', cleanId);
            
            // Tentar obter a variável de várias formas
            let variable = figma.variables.getVariableById(id);
            if (!variable) {
              console.log('Tentando com ID limpo...');
              variable = figma.variables.getVariableById(cleanId);
            }

            if (!variable) {
              // Tentar encontrar a variável listando todas as variáveis
              console.log('Tentando encontrar variável em todas as variáveis...');
              const allVars = figma.variables.getLocalVariables();
              console.log('Total de variáveis:', allVars.length);
              
              const foundVar = allVars.find(v => 
                v.id === id || 
                v.id === cleanId || 
                v.id.replace(/^VariableID:/, '') === cleanId
              );
              
              if (foundVar) {
                console.log('Variável encontrada pelo método alternativo');
                variable = foundVar;
              }
            }

            if (!variable) {
              console.log('❌ Variável não encontrada');
              errors.push(`Variável não encontrada: ${id}`);
              continue;
            }

            console.log(`✅ Encontrada: ${variable.name} (${variable.id})`);
            
            // Verificar se a variável está realmente não utilizada
            console.log('Verificando referências...');
            const isReferenced = await checkVariableReferences(variable);
            if (isReferenced) {
              console.log('⚠️ Variável está em uso, pulando...');
              errors.push(`Variável ${variable.name} está em uso`);
              continue;
            }

            // Tentar excluir
            console.log('🗑️ Iniciando processo de exclusão...');
            try {
              // Verificar permissões
              console.log('Verificando permissões...');
              const collection = figma.variables.getVariableCollectionById(variable.variableCollectionId);
              if (!collection) {
                throw new Error('Coleção não encontrada');
              }

              // Tentar excluir
              console.log('Executando comando remove()...');
              variable.remove();
              
              // Aguardar um momento para a operação ser processada
              console.log('Aguardando processamento...');
              await new Promise(resolve => setTimeout(resolve, 500));
              
              // Verificar se foi excluída (tentar ambos os formatos de ID)
              console.log('Verificando se a variável ainda existe...');
              const stillExists = figma.variables.getVariableById(variable.id) || 
                                figma.variables.getVariableById(cleanId);
              
              if (stillExists) {
                console.log('⚠️ Variável ainda existe após tentativa de exclusão');
                throw new Error(`Falha ao excluir ${variable.name}`);
              }

              console.log('✅ Excluída com sucesso!');
              successCount++;

            } catch (removeError) {
              console.error('❌ Erro durante a remoção:', removeError);
              throw removeError;
            }

          } catch (error) {
            console.error('❌ Erro:', error);
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }

        // Relatório final
        console.log('\n📊 Relatório de exclusão:');
        console.log(`Total processado: ${variableIds.length}`);
        console.log(`Sucesso: ${successCount}`);
        console.log(`Erros: ${errors.length}`);
        
        if (errors.length > 0) {
          console.log('\nErros encontrados:');
          errors.forEach(err => console.log(`- ${err}`));
        }

        // Notificar o usuário
        if (successCount > 0) {
          figma.notify(`✅ ${successCount} variáveis excluídas com sucesso`);
          figma.ui.postMessage({ type: 'delete-result', success: true });
        } else {
          throw new Error('Nenhuma variável foi excluída');
        }

      } catch (error) {
        console.error('\n❌ Erro durante o processo:', error);
        figma.notify(error instanceof Error ? error.message : 'Erro ao excluir variáveis', { error: true });
        figma.ui.postMessage({ 
          type: 'delete-result',
          success: false,
          error: error instanceof Error ? error.message : 'Erro desconhecido'
        });
      }
      break;

    case 'close':
      figma.closePlugin();
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
            console.log(`🔗 Found reference in node ${node.name} (${node.type})`);
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