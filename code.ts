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
      if (textNode.textStyleId) {
        const textStyle = figma.getStyleById(textNode.textStyleId);
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
    // Scan all pages
    for (const page of figma.root.children) {
      await scanNodes(page.children, usedVars);
    }

    // Check text styles
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

/**
 * Safely deletes variables with validation
 */
async function safeDeleteVariables(variables: Variable[]): Promise<Set<string>> {
  const deletedIds = new Set<string>();
  const total = variables.length;
  let processed = 0;

  try {
    for (const variable of variables) {
      // Update progress
      figma.ui.postMessage({
        type: 'deletion-progress',
        message: `Processing ${processed + 1}/${total}`,
        progress: (processed / total) * 100
      });

      try {
        // Ensure variable still exists
        const exists = figma.variables.getVariableById(variable.id);
        if (!exists) {
          console.warn(`⚠️ Variable ${variable.name} no longer exists`);
          continue;
        }

        // Get collection
        const collection = figma.variables.getVariableCollectionById(variable.variableCollectionId);
        if (!collection) {
          console.warn(`⚠️ Collection not found for variable: ${variable.name}`);
          continue;
        }

        // Force detach from all nodes
        await detachVariableFromAllNodes(variable);
        
        // Attempt deletion with verification
        let deleteAttempts = 3;
        let deleted = false;

        while (deleteAttempts > 0 && !deleted) {
          try {
            await variable.remove();
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // Verify deletion
            const stillExists = figma.variables.getVariableById(variable.id);
            if (!stillExists) {
              console.log(`✅ Successfully deleted: ${variable.name}`);
              deletedIds.add(variable.id);
              deleted = true;
            } else {
              console.warn(`⚠️ Variable still exists after deletion attempt`);
            }
          } catch (error) {
            console.warn(`⚠️ Deletion attempt failed: ${error}`);
          }
          deleteAttempts--;
          if (!deleted) {
            await new Promise(resolve => setTimeout(resolve, 300));
          }
        }

        if (!deleted) {
          console.error(`❌ Failed to delete variable: ${variable.name}`);
        }
      } catch (error) {
        console.error(`❌ Error processing ${variable.name}:`, error);
      }

      processed++;
    }
  } catch (error) {
    console.error('❌ Error in batch deletion:', error);
  }

  return deletedIds;
}

/**
 * Detaches a variable from all nodes that use it
 */
async function detachVariableFromAllNodes(variable: Variable): Promise<void> {
  const nodes = figma.root.findAll(node => {
    try {
      if (!('boundVariables' in node) || !node.boundVariables) return false;
      
      // Check all bindable properties
      return BINDABLE_PROPERTIES.some(prop => {
        const boundVars = (node as any)[prop]?.boundVariables;
        if (!boundVars) return false;
        
        return Object.values(boundVars).some(binding => {
          const bindings = Array.isArray(binding) ? binding : [binding];
          return bindings.some(b => b?.id === variable.id);
        });
      });
    } catch {
      return false;
    }
  });

  for (const node of nodes) {
    try {
      for (const prop of BINDABLE_PROPERTIES) {
        if ((node as any)[prop]?.boundVariables) {
          const originalValue = (node as any)[prop];
          if ('detachVariable' in node) {
            (node as any).detachVariable(prop);
          }
          (node as any)[prop] = originalValue;
        }
      }
    } catch (error) {
      console.warn(`⚠️ Error detaching from node ${node.name}:`, error);
    }
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
  console.time('Variable Analysis');
  console.log('🔍 Starting unused variables analysis...');
  
  const stats: ProcessingStats = {
    startTime: Date.now(),
    nodesProcessed: 0,
    variablesFound: 0
  };

  try {
    // Get all variables and validate
    figma.ui.postMessage({
      type: 'progress',
      message: 'Getting variables...',
      progress: 0
    });

    const variables = await getAllVariables(selectedCollections);
    if (!variables.length) {
      console.log('ℹ️ No variables found in selected collections');
      return [];
    }

    // Create lookup maps for better performance
    const variableMap = new Map(variables.map(v => [v.id, v]));
    const usedVariableIds = new Set<string>();
    
    // Get all pages and their nodes
    figma.ui.postMessage({
      type: 'progress',
      message: 'Analyzing document structure...',
      progress: 10
    });

    const pages = figma.root.children;
    const totalNodes = pages.reduce((count, page) => count + page.findAll().length, 0);
    let processedNodes = 0;

    // Process each page
    for (const page of pages) {
      console.log(`📄 Analyzing page: ${page.name}`);
      const nodes = page.findAll();

      // Process nodes in parallel batches
      const batches = [];
      for (let i = 0; i < nodes.length; i += BATCH_CONFIG.size) {
        const batch = nodes.slice(i, i + BATCH_CONFIG.size);
        batches.push(batch);
      }

      // Process batches with limited concurrency
      const batchPromises = [];
      for (let i = 0; i < batches.length; i += BATCH_CONFIG.maxParallelBatches) {
        const currentBatches = batches.slice(i, i + BATCH_CONFIG.maxParallelBatches);
        const promises = currentBatches.map(async batch => {
          const results = await processBatch(batch, stats);
          results.forEach(id => usedVariableIds.add(id));
          processedNodes += batch.length;
          
          // Update progress
          const progress = Math.min(90, 10 + (processedNodes / totalNodes * 80));
          figma.ui.postMessage({
            type: 'progress',
            message: `Analyzing nodes... (${processedNodes}/${totalNodes})`,
            progress,
            stats: {
              nodesProcessed: stats.nodesProcessed,
              variablesFound: stats.variablesFound
            }
          });
        });
        
        batchPromises.push(...promises);
        if (batchPromises.length >= BATCH_CONFIG.maxParallelBatches) {
          await Promise.all(batchPromises);
          batchPromises.length = 0;
          await new Promise(resolve => setTimeout(resolve, BATCH_CONFIG.delay));
        }
      }

      // Process any remaining promises
      if (batchPromises.length > 0) {
        await Promise.all(batchPromises);
      }
    }

    // Find unused variables
    figma.ui.postMessage({
      type: 'progress',
      message: 'Identifying unused variables...',
      progress: 95
    });

    const unusedVariables: VariableResult[] = [];
    for (const variable of variables) {
      if (!usedVariableIds.has(variable.id)) {
        try {
          const collection = figma.variables.getVariableCollectionById(variable.variableCollectionId);
          unusedVariables.push({
            name: variable.name,
            collection: collection?.name || 'No Collection',
            id: variable.id
          });
        } catch (error) {
          console.warn(`⚠️ Error processing variable ${variable.name}:`, error);
        }
      }
    }

    const executionTime = Date.now() - stats.startTime; // Changed from performance.now()
    console.log(`✅ Search completed in ${executionTime}ms`);
    console.log(`📊 Statistics:
    - Nodes processed: ${stats.nodesProcessed}
    - Variables found: ${stats.variablesFound}
    - Unused variables: ${unusedVariables.length}`);

    return unusedVariables;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('🔥 Critical error in findUnusedVariables:', errorMsg);
    throw new Error(`Failed to find unused variables: ${errorMsg}`);
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

    case 'delete-unused':
      try {
        console.time('Variable Deletion');
        console.log('🚀 Starting variable deletion process');

        // Show initial loading state
        figma.ui.postMessage({
          type: 'deletion-progress',
          message: 'Analyzing variables...',
          progress: 0
        });

        // Enable edit mode and get permissions
        figma.parameters.on('input', () => {});
        await figma.saveVersionHistoryAsync('Preparing to delete unused variables');

        // Get truly unused variables with enhanced detection
        const unusedVars = await getTrulyUnusedVariables();
        console.log(`📊 Found ${unusedVars.length} truly unused variables`);

        if (unusedVars.length === 0) {
          figma.notify('No unused variables found');
          figma.ui.postMessage({
            type: 'deletion-complete',
            stats: { totalVariables: 0 }
          });
          return;
        }

        // Show confirmation UI with count
        figma.ui.postMessage({
          type: 'confirm-deletion',
          count: unusedVars.length,
          message: `Found ${unusedVars.length} unused variables. Starting safe deletion process...`
        });

        // Perform the deletion
        try {
          // Process variables with safe deletion
          await safeDeleteVariables(unusedVars);
          console.timeEnd('Variable Deletion');

          // Get updated state after deletion
          const remainingVariables = figma.variables.getLocalVariables();
          const updatedCollections = figma.variables.getLocalVariableCollections().map(collection => ({
            id: collection.id,
            name: collection.name
          }));

          // Check which variables were successfully deleted
          const deletedVars = unusedVars.filter((v: Variable) => !figma.variables.getVariableById(v.id));

          // Send completion notification and update UI
          console.log(`Successfully deleted: ${deletedVars.map(v => v.name).join(', ')}`);
          figma.notify(`Successfully deleted ${deletedVars.length} variables`);

          // Trigger UI update
          figma.ui.postMessage({
            type: 'deletion-complete',
            deletedVariables: deletedVars,
            collections: updatedCollections,
            stats: {
              executionTime: 0,
              totalVariables: remainingVariables.length
            }
          });

          // Force cache refresh
          figma.ui.postMessage({ type: 'RELOAD_FILE' });
        } catch (deleteError) {
          console.error('❌ Error during deletion:', deleteError);
          figma.notify('Failed to complete variable deletion');
          throw deleteError;
        }
      } catch (error) {
        console.error('❌ Error deleting unused variables:', error);
        figma.notify('Failed to delete unused variables');
      }
      break;

    // ...rest of the cases...
  }
};