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

async function batchDeleteVariables(ids: string[], batchSize = 25): Promise<string[]> {
  const deletedIds: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    try {
      // Validate batch before deletion
      const validBatch = batch.filter(id => {
        const variable = figma.variables.getVariableById(id);
        if (!variable) {
          console.warn(`⚠️ Skipping invalid variable: ${id}`);
          return false;
        }
        return true;
      });

      if (validBatch.length > 0) {
        // Delete valid variables
        for (const id of validBatch) {
          const variable = figma.variables.getVariableById(id);
          if (variable) {
            await variable.remove();
            deletedIds.push(id);
            console.log(`✅ Deleted variable: ${variable.name} (${id})`);
          }
        }
      }

      // Add small delay between batches
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      const errorMessage = `Failed to process batch ${i / batchSize + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error(errorMessage);
      errors.push(errorMessage);
    }
  }

  if (errors.length > 0) {
    console.error('❌ Batch deletion errors:', errors);
  }

  return deletedIds;
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
  width: 320,
  height: 480,
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
 * @param selectedCollections Array of selected collection IDs to filter by
 */
async function findUnusedVariables(selectedCollections: string[] = []): Promise<VariableResult[]> {
  const stats: ProcessingStats = {
    startTime: Date.now(),
    nodesProcessed: 0,
    variablesFound: 0
  };

  try {
    // Get all variables from selected collections
    const allVariables = await getAllVariables(selectedCollections);
    
    // Get set of used variable IDs
    const usedVarIds = await getTrulyUnusedVariables();
    
    // Filter out used variables
    const unusedVars = allVariables.filter(v => !usedVarIds.some(uv => uv.id === v.id));

    // Format results
    return unusedVars.map(v => ({
      name: v.name,
      collection: v.collection,
      id: v.id
    }));

  } catch (error) {
    console.error('Error finding unused variables:', error instanceof Error ? error.message : String(error));
    throw error instanceof Error ? error : new Error('Unknown error finding unused variables');
  }
}

/**
 * Creates a text node in the Figma document with the analysis results
 */
async function createTextNode(unusedVars: VariableResult[]): Promise<TextNode | null> {
  try {
    const text = figma.createText();
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });

    if (unusedVars.length === 0) {
      text.characters = "✅ No unused variables found!";
    } else {
      // Group variables by collection
      const byCollection: { [key: string]: VariableResult[] } = {};
      unusedVars.forEach(v => {
        if (!byCollection[v.collection]) byCollection[v.collection] = [];
        byCollection[v.collection].push(v);
      });

      // Create content with all text
      let content = "📊 Unused Variables Report\n";
      content += "───────────────────────\n\n";
      content += `Total unused variables: ${unusedVars.length}\n\n`;

      // Add each collection section
      Object.entries(byCollection).forEach(([collection, vars]) => {
        content += `${collection} (${vars.length})\n`;
        content += `${vars.map(v => `  • ${v.name}`).join('\n')}\n\n`;
      });

      text.characters = content;
    }

    const viewport = figma.viewport.bounds;
    text.x = viewport.x + 50;
    text.y = viewport.y + 50;

    return text;
  } catch (error) {
    console.error('❌ Error creating text node:', error);
    return null;
  }
}

// Add deep cleaning functionality
async function deepCleanVariables(variableIds: string[]): Promise<void> {
  console.log('🧹 Starting deep clean for variables:', variableIds);

  try {
    // Step 1: Clear component instance bindings
    console.log('Cleaning component instances...');
    const instances = figma.root.findAll(n => n.type === 'INSTANCE') as InstanceNode[];
    for (const instance of instances) {
      try {
        if ('componentProperties' in instance) {
          const properties = instance.componentProperties;
          for (const [key, prop] of Object.entries(properties)) {
            if (prop.boundVariables) {
              for (const varId of variableIds) {
                if (prop.boundVariables.hasOwnProperty(varId)) {
                  try {
                    // Clear the binding by reassigning the property
                    const currentValue = (instance as any)[key];
                    (instance as any)[key] = currentValue;
                    console.log(`✅ Cleared binding for ${key} in ${instance.name}`);
                  } catch (error) {
                    console.warn(`⚠️ Failed to clear binding in ${instance.name}: ${error}`);
                  }
                }
              }
            }
          }
        }
      } catch (error) {
        console.warn(`⚠️ Error processing instance ${instance.name}: ${error}`);
      }
    }

    // Step 2: Clear text node bindings
    console.log('Cleaning text nodes...');
    const textNodes = figma.root.findAll(n => n.type === 'TEXT') as TextNode[];
    for (const node of textNodes) {
      try {
        if (node.boundVariables) {
          for (const [prop, binding] of Object.entries(node.boundVariables)) {
            if (!binding) continue;
            
            const bindings = Array.isArray(binding) ? binding : [binding];
            for (const b of bindings) {
              if (b?.type === 'VARIABLE_ALIAS' && typeof b.id === 'string' && variableIds.includes(b.id)) {
                try {
                  // Clear text node binding
                  node.setBoundVariable(
                    prop as VariableBindableTextField | VariableBindableNodeField,
                    null
                  );
                  console.log(`✅ Cleared text binding for ${prop} in ${node.name}`);
                } catch (error) {
                  console.warn(`⚠️ Failed to clear text binding: ${error}`);
                }
              }
            }
          }
        }
      } catch (error) {
        console.warn(`⚠️ Error processing text node ${node.name}: ${error}`);
      }
    }

    // Step 3: Clear effect variables
    console.log('Cleaning effect variables...');
    const nodesWithEffects = figma.root.findAll(n => 'effects' in n && n.effects?.length > 0);
    for (const node of nodesWithEffects) {
      try {
        if ('effects' in node) {
          const cleanedEffects = (node.effects || []).map(effect => {
            // Check all possible variable bindings in effects
            const boundVars = effect.boundVariables || {};
            const hasTargetBinding = Object.values(boundVars).some(binding => {
              if (!binding) return false;
              const b = binding as VariableAlias;
              return b.type === 'VARIABLE_ALIAS' && variableIds.includes(b.id);
            });

            if (hasTargetBinding) {
              // Create new effect without any variable bindings
              const { boundVariables, ...cleanEffect } = effect;
              return cleanEffect;
            }
            return effect;
          });
          (node as any).effects = cleanedEffects;
        }
      } catch (error) {
        console.warn(`⚠️ Error cleaning effects for node ${node.name}: ${error}`);
      }
    }

    // Step 4: Clear variable references in other variables
    console.log('Cleaning variable references...');
    const collections = figma.variables.getLocalVariableCollections();
    for (const collection of collections) {
      for (const varId of collection.variableIds) {
        const variable = figma.variables.getVariableById(varId);
        if (!variable || variableIds.includes(varId)) continue;

        for (const [modeId, value] of Object.entries(variable.valuesByMode)) {
          if (typeof value === 'object' && value !== null && 'id' in value) {
            if (variableIds.includes(value.id)) {
              try {
                const defaultValue = (() => {
                  switch (variable.resolvedType) {
                    case 'COLOR': return { r: 0, g: 0, b: 0, a: 1 };
                    case 'FLOAT': return 0;
                    case 'BOOLEAN': return false;
                    default: return '';
                  }
                })();
                variable.setValueForMode(modeId, defaultValue);
                console.log(`✅ Cleared reference in ${variable.name} for mode ${modeId}`);
              } catch (error) {
                console.warn(`⚠️ Failed to clear variable reference: ${error}`);
              }
            }
          }
        }
      }
    }

    // Step 5: Force garbage collection
    console.log('Forcing garbage collection...');
    await figma.getNodeByIdAsync('0:0');
    await new Promise(resolve => setTimeout(resolve, 500));

  } catch (error) {
    console.error('❌ Error in deep clean:', error);
    throw error;
  }
}

// Helper function to clear effect bindings
async function clearEffectBindings(ids: string[]): Promise<void> {
  console.log('🧹 Clearing effect bindings for variables:', ids);
  
  const nodesWithEffects = figma.root.findAll(n => 
    'effects' in n && (n as any).effects?.some((e: Effect) => 
      (e as any).boundVariables && Object.values((e as any).boundVariables).some(binding => {
        if (!binding) return false;
        const b = binding as VariableAlias;
        return b.type === 'VARIABLE_ALIAS' && ids.includes(b.id);
      })
    )
  );
  
  for (const node of nodesWithEffects) {
    if ('effects' in node) {
      try {
        const cleanedEffects = ((node as any).effects || []).map((effect: Effect) => {
          if (!(effect as any).boundVariables) return effect;
          
          // Create new effect without variable bindings that are being deleted
          const { boundVariables, ...cleanEffect } = effect as any;
          const newBindings: Record<string, VariableAlias> = {};
          
          Object.entries(boundVariables).forEach(([key, binding]) => {
            if (!binding) return;
            const b = binding as VariableAlias;
            if (b.type !== 'VARIABLE_ALIAS' || !ids.includes(b.id)) {
              newBindings[key] = binding as VariableAlias;
            }
          });
          
          if (Object.keys(newBindings).length > 0) {
            (cleanEffect as any).boundVariables = newBindings;
          }
          
          return cleanEffect;
        });
        
        (node as any).effects = cleanedEffects;
      } catch (error) {
        console.warn(`⚠️ Failed to clean effects for node ${node.name}:`, error);
      }
    }
  }
}

// Helper function to clear text style bindings
async function clearTextStyleBindings(ids: string[]): Promise<void> {
  console.log('🧹 Clearing text style bindings for variables:', ids);
  
  const textStyles = figma.getLocalTextStyles();
  for (const style of textStyles) {
    try {
      if (style.boundVariables) {
        for (const [prop, binding] of Object.entries(style.boundVariables)) {
          if (!binding) continue;
          const bindings = Array.isArray(binding) ? binding : [binding];
          for (const b of bindings) {
            if (b?.type === 'VARIABLE_ALIAS' && ids.includes(b.id)) {
              // Only set text-specific bindings
              if (prop === 'fontSize' || prop === 'letterSpacing' || prop === 'lineHeight' || prop === 'paragraphIndent' || prop === 'paragraphSpacing') {
                style.setBoundVariable(prop, null);
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn(`⚠️ Failed to clean text style ${style.name}:`, error);
    }
  }
}

// Helper function to clear component bindings
async function clearComponentBindings(ids: string[]): Promise<void> {
  console.log('🧹 Clearing component bindings for variables:', ids);
  
  interface VariableValue {
    type: 'VARIABLE';
    id: string;
  }

  // Type guard for variable default value
  const isVariableValue = (value: any): value is VariableValue => {
    return value && typeof value === 'object' && 
           'type' in value && value.type === 'VARIABLE' &&
           'id' in value && typeof value.id === 'string';
  };
  
  // Handle master components first
  const masterComponents = figma.root.findAll(n => 
    n.type === 'COMPONENT' && 
    Object.entries(n.componentPropertyDefinitions || {}).some(([_, def]) => {
      const defaultValue = def.defaultValue;
      if (!defaultValue || typeof defaultValue !== 'object') return false;
      return isVariableValue(defaultValue) && ids.includes(defaultValue.id);
    })
  ) as ComponentNode[];

  for (const component of masterComponents) {
    try {
      const definitions = component.componentPropertyDefinitions;
      for (const [key, def] of Object.entries(definitions)) {
        const defaultValue = def.defaultValue;
        if (!defaultValue || typeof defaultValue !== 'object') continue;
        
        if (isVariableValue(defaultValue) && ids.includes(defaultValue.id)) {
          // Clear the default value while preserving other property settings
          component.editComponentProperty(key, {
            ...def,
            defaultValue: undefined
          });
        }
      }
    } catch (error) {
      console.warn(`⚠️ Failed to clean master component ${component.name}:`, error);
    }
  }

  // Handle component instances
  const instances = figma.root.findAll(n => n.type === 'INSTANCE') as InstanceNode[];
  for (const instance of instances) {
    try {
      if (instance.componentProperties) {
        for (const [key, prop] of Object.entries(instance.componentProperties)) {
          if (prop.boundVariables) {
            for (const [subKey, binding] of Object.entries(prop.boundVariables)) {
              if (!binding) continue;
              const bindings = Array.isArray(binding) ? binding : [binding];
              for (const b of bindings) {
                if (b?.type === 'VARIABLE_ALIAS' && ids.includes(b.id)) {
                  // Reset to component's default value
                  const currentValue = (instance as any)[key];
                  (instance as any)[key] = currentValue;
                }
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn(`⚠️ Failed to clean instance ${instance.name}:`, error);
    }
  }
}

// Main function for guaranteed variable deletion
async function guaranteedVariableDeletion(ids: string[]): Promise<{ success: boolean; deletedIds: string[]; errors: string[] }> {
  console.log('🚀 Starting guaranteed variable deletion for:', ids);
  
  const sanitizedIds = ids.map(id => id.replace(/^VariableID:/, ''));
  const errors: string[] = [];
  
  try {
    // 1. Extended safety check
    const existingVars = sanitizedIds.filter(id => {
      const varExists = figma.variables.getVariableById(id);
      if (!varExists) {
        console.log(`⚠️ Variable ${id} no longer exists`);
        return false;
      }
      return true;
    });

    if (existingVars.length === 0) {
      return { success: true, deletedIds: [], errors: ['No valid variables to delete'] };
    }

    // 2. Multi-layer deep cleanup
    console.log('🧹 Starting deep cleanup...');
    await clearComponentBindings(existingVars);
    await clearTextStyleBindings(existingVars);
    await clearEffectBindings(existingVars);

    // 3. Force garbage collection
    console.log('🗑️ Forcing garbage collection...');
    await figma.getNodeByIdAsync('0:0');
    await new Promise(resolve => setTimeout(resolve, 500));

    // 4. Final deletion with batch processing
    console.log('🗑️ Executing final deletion...');
    const deletedIds: string[] = [];
    const BATCH_SIZE = 25;

    for (let i = 0; i < existingVars.length; i += BATCH_SIZE) {
      const batch = existingVars.slice(i, i + BATCH_SIZE);
      try {
        for (const id of batch) {
          const variable = figma.variables.getVariableById(id);
          if (variable) {
            await variable.remove();
            deletedIds.push(id);
            console.log(`✅ Successfully deleted variable: ${variable.name} (${id})`);
          }
        }
        // Add small delay between batches
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        const errorMessage = `Failed to process batch ${i / BATCH_SIZE + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(errorMessage);
        errors.push(errorMessage);
      }
    }

    // 5. Verify deletion and force UI refresh
    console.log('🔍 Verifying deletion...');
    const remainingVars = deletedIds.filter(id => figma.variables.getVariableById(id));
    if (remainingVars.length > 0) {
      console.warn('⚠️ Some variables still exist after deletion:', remainingVars);
      errors.push(`Failed to delete variables: ${remainingVars.join(', ')}`);
    }

    // Force UI refresh
    const currentPage = figma.currentPage;
    currentPage.selection = [currentPage as unknown as SceneNode];
    setTimeout(() => { currentPage.selection = []; }, 100);

    return {
      success: deletedIds.length > 0,
      deletedIds,
      errors
    };
  } catch (error) {
    const errorMessage = `Critical error during deletion: ${error instanceof Error ? error.message : 'Unknown error'}`;
    console.error(errorMessage);
    errors.push(errorMessage);
    return {
      success: false,
      deletedIds: [],
      errors
    };
  }
}

// Update safeDeleteVariables to use the new guaranteed deletion
async function safeDeleteVariables(variableIds: string[]): Promise<VariableResult[]> {
  const deletedVariables: VariableResult[] = [];
  
  try {
    console.log('🔍 Starting variable deletion process with raw IDs:', variableIds);
    
    const result = await guaranteedVariableDeletion(variableIds);
    
    if (!result.success) {
      throw new Error(`Failed to delete variables: ${result.errors.join(', ')}`);
    }

    // Record successfully deleted variables
    for (const id of result.deletedIds) {
      const variable = figma.variables.getVariableById(id);
      if (variable) {
        const collection = figma.variables.getVariableCollectionById(variable.variableCollectionId);
        deletedVariables.push({
          name: variable.name,
          collection: collection?.name || 'Unknown Collection',
          id: id
        });
      }
    }

    // Force UI refresh with multiple techniques
    await figma.viewport.scrollAndZoomIntoView([figma.root]);
    figma.root.setRelaunchData({ refresh: '1' });
    
    if (deletedVariables.length === 0 && result.errors.length > 0) {
      throw new Error(`Failed to delete any variables: ${result.errors.join(', ')}`);
    }

    console.log(`📊 Deletion summary: ${deletedVariables.length} variables deleted:`, deletedVariables);
    return deletedVariables;
  } catch (error) {
    console.error('❌ Error in safeDeleteVariables:', error);
    throw error;
  }
}

// Event Handlers
figma.ui.onmessage = async (msg) => {
  console.log('📨 Plugin received message:', msg.type, msg);

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
      } catch (error) {
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
      } catch (error) {
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
      } catch (error) {
        console.error('❌ Error printing unused variables:', error);
        figma.notify('Failed to print unused variables');
      }
      break;

    case 'delete-variables':
      try {
        console.log('🗑️ Starting variable deletion...', msg.variables);
        
        if (!msg.variables || msg.variables.length === 0) {
          throw new Error('No variables selected for deletion');
        }

        // Notify deletion start
        figma.notify('Deleting variables...', { timeout: 2000 });
        
        const deletedVars = await safeDeleteVariables(msg.variables);
        console.log('✅ Deletion completed, sending results to UI:', deletedVars);
        
        if (deletedVars.length === 0) {
          throw new Error('Failed to delete any variables');
        }

        // Force refresh of the Figma UI
        await figma.viewport.scrollAndZoomIntoView([figma.root]);
        figma.root.setRelaunchData({ refresh: '' });
        
        // Send deletion complete message first
        figma.ui.postMessage({ 
          type: 'deletion-complete',
          deletedVariables: deletedVars.map(v => ({
            name: v.name,
            collection: v.collection,
            id: v.id
          }))
        });

        // Wait a bit before showing notification
        await new Promise(resolve => setTimeout(resolve, 500));
        
        figma.notify(`Successfully deleted ${deletedVars.length} variables`, { timeout: 2000 });

        // Refresh collections after deletion
        const collections = figma.variables.getLocalVariableCollections().map(collection => ({
          id: collection.id,
          name: collection.name
        }));
        
        figma.ui.postMessage({ 
          type: 'collections',
          collections: collections
        });
      } catch (error) {
        console.error('❌ Error deleting variables:', error);
        figma.notify('Failed to delete variables: ' + (error instanceof Error ? error.message : 'Unknown error'), { error: true });
        figma.ui.postMessage({ 
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to delete variables'
        });
      }
      break;
  }
};