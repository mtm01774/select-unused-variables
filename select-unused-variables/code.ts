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

// Add after existing interfaces

// Add after constants declaration

// Function to send status updates to the UI
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

// Add after figma.showUI

// Configure event listeners
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
    console.log('📚 Collections found:', collections);
    
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
    console.log(`📊 Total variables: ${rawVariables.length}`);
    
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
 * Finds unused variables with cache support and filters
 */
async function findUnusedVariables(options: FilterOptions = {
  types: new Set(),
  collections: new Set(),
  modes: new Set()
}): Promise<VariableResult[]> {
  console.log('🔍 Starting search for unused variables...');
  
  try {
    // Clear expired cache
    cleanExpiredCache();
    
    // Get all variables
    const allVariables = figma.variables.getLocalVariables();
    console.log(`📊 Total variables: ${allVariables.length}`);
    
    // Apply initial filters
    const filteredVariables = await filterVariables(allVariables, options);
    console.log(`📊 Variables after filters: ${filteredVariables.length}`);
    
    // Check usage of each variable (using cache)
    const unusedVariables: VariableResult[] = [];
    let analyzed = 0;
    
    for (const variable of filteredVariables) {
      analyzed++;
      updateStatus({ analyzed });
      
      if (variable.isDeleted) {
        console.log(`⏭️ Ignoring deleted variable: ${variable.name}`);
        continue;
      }
      
      // Check in cache
      const status = await getCachedVariableStatus(variable);
      
      if (!status.isUsed) {
        const collection = figma.variables.getVariableCollectionById(variable.variableCollectionId);
        unusedVariables.push({
          name: variable.name,
          collection: collection?.name || '[unknown-collection]',
          id: variable.id
        });
        
        console.log(`🎯 Unused variable found: ${variable.name} (${variable.id})`);
        console.log(`   Type: ${status.resolvedType}`);
        if (status.usageLocations.length > 0) {
          console.log('   Last usage locations:', status.usageLocations);
        }
      }
    }
    
    // Update statistics
    updateStatus({
      total: allVariables.length,
      analyzed,
      unused: unusedVariables.length
    });
    
    return unusedVariables;
    
  } catch (error) {
    console.error('❌ Error fetching variables:', error);
    throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
        console.log(`📚 Collections found: ${collections.length}`);
        
        if (!collections || collections.length === 0) {
          console.log('⚠️ No collections found');
          figma.notify('No collections of variables found');
          figma.ui.postMessage({ 
            type: 'collections',
            collections: []
          });
          return;
        }
        
        const mappedCollections = collections.map(collection => {
          console.log(`📝 Processing collection: ${collection.name} (${collection.id})`);
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
        console.error('❌ Error during initialization:', error);
        figma.notify('Error initializing the plugin', { error: true });
        figma.ui.postMessage({ 
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error'
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
        console.error('❌ Error getting types:', error);
      }
      break;

    case 'clear-cache':
      try {
        variableCache.clear();
        figma.notify('✨ Cache limpo com sucesso');
      } catch (error) {
        console.error('❌ Error clearing cache:', error);
        figma.notify('✨ Cache cleared successfully');
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
        console.log('🗑️ Starting variable deletion:', msg);
        
        if (!msg.variables?.length) {
          throw new Error('No variables to delete');
        }

        // Process each variable in the array
        for (const variable of msg.variables) {
          try {
            console.log(`\n🔍 Looking for variable with ID: ${variable.id}`);
            
            // Get the variable using the ID
            const variableToDelete = figma.variables.getVariableById(variable.id);
            
            if (!variableToDelete) {
              throw new Error(`Variable not found: ${variable.name} (${variable.id})`);
            }
            
            console.log(`🗑️ Deleting variable: ${variableToDelete.name}`);
            
            // Try to delete
            await variableToDelete.remove();
            
            // Check if it was deleted
            await new Promise(resolve => setTimeout(resolve, 500));
            const stillExists = figma.variables.getVariableById(variable.id);
            
            if (stillExists) {
              throw new Error('Variable still exists after deletion attempt');
            }
            
            console.log(`✅ Variable successfully deleted: ${variableToDelete.name}`);
          } catch (error) {
            console.error(`❌ Error deleting variable:`, error);
            throw error;
          }
        }
        
        // Send results to UI
        figma.ui.postMessage({ 
          type: 'delete-result',
          success: true,
          stats: {
            total: msg.variables.length,
            success: msg.variables.length,
            errors: 0
          }
        });
        
        figma.notify(`✅ ${msg.variables.length} ${msg.variables.length === 1 ? 'variable' : 'variables'} successfully deleted`);
        
      } catch (error) {
        console.error('❌ Error during deletion:', error);
        figma.ui.postMessage({ 
          type: 'delete-result',
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        figma.notify('Error deleting variables', { error: true });
      }
      break;

    case 'close':
      figma.closePlugin();
      break;

    case 'map-design-variables':
      try {
        console.log('🎨 Starting design variable mapping...');
        const designMap = await mapDesignVariables();
        
        // Send results to UI
        figma.ui.postMessage({
          type: 'design-variables-mapped',
          data: {
            colors: Array.from(designMap.colors.entries()),
            typography: Array.from(designMap.typography.entries()),
            effects: Array.from(designMap.effects.entries()),
            other: Array.from(designMap.other.entries())
          }
        });

        // Execute collections cleanup
        await cleanupCollections(designMap);
        
        figma.notify('✨ Variable mapping completed');
      } catch (error) {
        console.error('❌ Error during mapping:', error);
        figma.notify('Error mapping variables', { error: true });
      }
      break;

    case 'variableschanged':
      try {
        const designMap = await mapDesignVariables();
        updateStatus({
          total: designMap.colors.size + designMap.typography.size + designMap.effects.size + designMap.other.size
        });
      } catch (error) {
        console.error('❌ Error updating status:', error);
      }
      break;
  }
};

// Helper function to check references more robustly
async function checkVariableReferences(variable: Variable): Promise<boolean> {
  try {
    const collections = figma.variables.getLocalVariableCollections();
    
    // Check references in other variables
    for (const collection of collections) {
      for (const varId of collection.variableIds) {
        if (varId === variable.id) continue;
        
        const var2 = figma.variables.getVariableById(varId);
        if (!var2) continue;

        // Check all references in all modes
        for (const [modeId, value] of Object.entries(var2.valuesByMode)) {
          if (typeof value === 'object' && value !== null) {
            const valueObj = value as any;
            // Compare clean IDs (without the VariableID: prefix)
            if (valueObj.type === 'VARIABLE_ALIAS' && 
                valueObj.id.replace(/^VariableID:/, '') === variable.id) {
              console.log(`🔗 Variable ${variable.name} is referenced by ${var2.name}`);
              return true;
            }
          }
        }
      }
    }

    // Check references in components and instances
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
    return true; // In case of error, assume there are references for safety
  }
}

// Helper function to check references in nodes
async function checkNodeForReferences(node: BaseNode, variableId: string): Promise<boolean> {
  try {
    // Check if the node has bound variables
    if ('boundVariables' in node) {
      const boundVars = (node as any).boundVariables;
      if (boundVars) {
        for (const prop in boundVars) {
          const binding = boundVars[prop];
          if (Array.isArray(binding)) {
            for (const b of binding) {
              // Compare clean IDs
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

    // Recursively check children
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
 * Checks all variable bindings in design elements
 * @returns Set with IDs of variables in use
 */
async function getActiveVariableReferences(): Promise<Set<string>> {
  const usedVariableIds = new Set<string>();
  const propertiesToCheck = ['fills', 'strokes', 'effects', 'textStyleId'];

  const processNode = async (node: SceneNode) => {
    try {
      // Check each property that may have bound variables
      for (const prop of propertiesToCheck) {
        try {
          const boundVariable = node.getBoundVariable(prop as VariableBindableType);
          if (boundVariable) {
            const varId = boundVariable.id;
            usedVariableIds.add(varId);
            usedVariableIds.add(varId.replace(/^VariableID:/, '')); // Version without prefix
            console.log(`🔗 Bound variable found:
              Node: ${node.name}
              Property: ${prop}
              ID: ${varId}
            `);
          }
        } catch (propError) {
          // Some properties may not be available on all node types
          continue;
        }
      }

      // Check specific text properties
      if (node.type === 'TEXT') {
        const textNode = node as TextNode;
        try {
          const textStyleVariable = textNode.getBoundVariable('textStyleId');
          if (textStyleVariable) {
            usedVariableIds.add(textStyleVariable.id);
            usedVariableIds.add(textStyleVariable.id.replace(/^VariableID:/, ''));
          }
        } catch (textError) {
          console.warn(`⚠️ Error checking text style in ${node.name}:`, textError);
        }
      }

      // Recursively check children
      if ('children' in node) {
        for (const child of node.children) {
          await processNode(child as SceneNode);
        }
      }

    } catch (nodeError) {
      console.warn(`⚠️ Error processing node ${node.name}:`, nodeError);
    }
  };

  // Process all pages
  console.log('🔍 Starting bound variables verification...');
  for (const page of figma.root.children) {
    console.log(`📄 Processing page: ${page.name}`);
    for (const node of page.children) {
      await processNode(node as SceneNode);
    }
  }

  // Compare with all local variables
  const allVariables = figma.variables.getLocalVariables();
  console.log(`\n Summary:
    Total variables: ${allVariables.length}
    Variables in use: ${usedVariableIds.size}
    Variables not used: ${allVariables.length - usedVariableIds.size}
  `);

  return usedVariableIds;
}

/**
 * Filter unused variables comparing with IDs set of used variables
 * @param usedIds Set with IDs of variables in use
 * @returns Array with unused variables
 */
async function filterUnusedVariables(usedIds: Set<string>): Promise<Variable[]> {
  console.log('🔍 Starting unused variables filtering...');
  
  try {
    const allVariables = figma.variables.getLocalVariables();
    updateStatus({ total: allVariables.length });
    
    let analyzed = 0;
    let unused = 0;
    
    const unusedVariables = allVariables.filter(variable => {
      analyzed++;
      updateStatus({ analyzed });
      
      if (variable.isDeleted) {
        console.log(`⏭️ Ignoring deleted variable: ${variable.name}`);
        return false;
      }
      
      const originalId = variable.id;
      const cleanId = variable.id.replace(/^VariableID:/, '');
      const isUsed = usedIds.has(originalId) || usedIds.has(cleanId);
      
      if (!isUsed) {
        unused++;
        updateStatus({ unused });
        console.log(`🎯 Unused variable found: ${variable.name} (${originalId})`);
      }
      
      return !isUsed;
    });
    
    return unusedVariables;
    
  } catch (error) {
    console.error('❌ Error filtering variables:', error);
    throw new Error(`Failed to filter variables: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Interfaces for design variable mapping
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
 * Maps all design variables in the document
 * @returns Organized map of variables by type
 */
async function mapDesignVariables(): Promise<DesignVariableMap> {
  console.log('🎨 Starting design variable mapping...');
  
  const designMap: DesignVariableMap = {
    colors: new Map(),
    typography: new Map(),
    effects: new Map(),
    other: new Map()
  };

  try {
    // Get all collections and their modes
    const collections = figma.variables.getLocalVariableCollections();
    console.log(`📚 Found ${collections.length} collections`);

    for (const collection of collections) {
      console.log(`\n🗂️ Checking collection: ${collection.name}`);
      
      // Process each variable in the collection
      for (const varId of collection.variableIds) {
        const variable = figma.variables.getVariableById(varId);
        if (!variable) continue;

        // Create extended variable information
        const varInfo: VariableInfo = {
          ...variable,
          usages: [],
          collectionName: collection.name,
          modes: {}
        };

        // Process values in different modes
        Object.entries(variable.valuesByMode).forEach(([modeId, value]) => {
          varInfo.modes[modeId] = {
            value,
            references: []
          };

          // Check references in other modes
          if (typeof value === 'object' && value !== null && 'type' in value) {
            if (value.type === 'VARIABLE_ALIAS') {
              varInfo.modes[modeId].references.push(value.id);
            }
          }
        });

        // Categorize variable based on type
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

    // Map usage in components and instances
    await mapComponentUsage(designMap);

    // Generate report
    console.log('\n📊 Variables Report:');
    console.log(`Cores: ${designMap.colors.size}`);
    console.log(`Tipografia: ${designMap.typography.size}`);
    console.log(`Efeitos: ${designMap.effects.size}`);
    console.log(`Outros: ${designMap.other.size}`);

    return designMap;

  } catch (error) {
    console.error('❌ Error mapping variables:', error);
    throw new Error(`Failed to map variables: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Maps the usage of variables in components and instances
 */
async function mapComponentUsage(designMap: DesignVariableMap): Promise<void> {
  console.log('\n🔍 Mapeando uso em componentes...');

  const processNode = async (node: SceneNode) => {
    try {
      // Check bound variables
      if ('boundVariables' in node) {
        const boundVars = node.boundVariables as Record<string, VariableBinding | VariableBinding[]>;
        
        for (const [property, binding] of Object.entries(boundVars)) {
          const bindings = Array.isArray(binding) ? binding : [binding];
          
          for (const b of bindings) {
            if (b?.type === 'VARIABLE_ALIAS' && b.id) {
              // Register variable usage
              const usage: VariableUsageMap = {
                nodeId: node.id,
                nodeName: node.name,
                properties: [property]
              };

              // Add to appropriate category
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

      // Process children recursively
      if ('children' in node) {
        for (const child of node.children) {
          await processNode(child as SceneNode);
        }
      }
    } catch (error) {
      console.warn(`⚠️ Error processing node ${node.name}:`, error);
    }
  };

  // Process all pages
  for (const page of figma.root.children) {
    console.log(`📄 Processing page: ${page.name}`);
    for (const node of page.children) {
      await processNode(node as SceneNode);
    }
  }
}

/**
 * Removes empty collections and cleans broken references
 */
async function cleanupCollections(designMap: DesignVariableMap): Promise<void> {
  console.log('\n🧹 Starting collections cleanup...');
  
  try {
    const collections = figma.variables.getLocalVariableCollections();
    
    for (const collection of collections) {
      console.log(`\n🗂️ Checking collection: ${collection.name}`);
      
      // Check if the collection is empty
      if (collection.variableIds.length === 0) {
        console.log(`🗑️ Removing empty collection: ${collection.name}`);
        collection.remove();
        continue;
      }

      // Check variables with broken references
      let hasValidVariables = false;
      for (const varId of collection.variableIds) {
        const variable = figma.variables.getVariableById(varId);
        if (!variable) continue;

        // Check all references in all modes
        for (const [modeId, value] of Object.entries(variable.valuesByMode)) {
          if (typeof value === 'object' && value !== null && 'type' in value) {
            if (value.type === 'VARIABLE_ALIAS') {
              const referencedVar = figma.variables.getVariableById(value.id);
              if (!referencedVar) {
                console.log(`⚠️ Broken reference found in ${variable.name}`);
                // Clear broken reference
                variable.valuesByMode[modeId] = null;
              }
            }
          }
          if (value !== null) hasValidVariables = true;
        }
      }

      // Remove collection if it has no valid variables
      if (!hasValidVariables) {
        console.log(`🗑️ Removing collection without valid variables: ${collection.name}`);
        collection.remove();
      }
    }

    console.log('✨ Collections cleanup completed');
    
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    throw new Error(`Cleanup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Cache System for Verifications

// Global cache with 5 minutes expiration time

// ... existing code ...

// Execute verification
// ... existing code ...

// Filter by collection
// ... existing code ...

console.log('✅ Validação concluída:', result);
console.log('✅ Validation completed:', result);