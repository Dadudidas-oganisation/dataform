import { utils, adapters } from "@dataform/core";
import * as protos from "@dataform/protos";
import * as dbadapters from "../dbadapters";

export function build(compiledGraph: protos.ICompiledGraph, runConfig: protos.IRunConfig, profile: protos.IProfile) {
  return new Builder(compiledGraph, runConfig, profile).build();
}

class Builder {
  private compiledGraph: protos.ICompiledGraph;
  private runConfig: protos.IRunConfig;

  private adapter: adapters.Adapter;
  private dbadapter: dbadapters.DbAdapter;

  constructor(compiledGraph: protos.ICompiledGraph, runConfig: protos.IRunConfig, profile: protos.IProfile) {
    this.compiledGraph = compiledGraph;
    this.runConfig = runConfig;
    this.adapter = adapters.create(compiledGraph.projectConfig);
    this.dbadapter = dbadapters.create(profile);
  }

  build(): Promise<protos.IExecutionGraph> {
    var databaseState: { [tableName: string]: protos.ITable } = {};
    return Promise.all(
      this.compiledGraph.materializations.map(m =>
        this.dbadapter
          .schema(m.target)
          .then(schema => (databaseState[m.name] = schema))
          .catch(_ => (databaseState[m.name] = {}))
      )
    ).then(() => {
      // Firstly, turn every thing into an execution node.
      var allNodes: protos.IExecutionNode[] = [].concat(
        this.compiledGraph.materializations.map(m => this.buildMaterialization(m, databaseState[m.name])),
        this.compiledGraph.operations.map(o => this.buildOperation(o)),
        this.compiledGraph.assertions.map(a => this.buildAssertion(a))
      );
      var allNodeNames = allNodes.map(n => n.name);
      var nodeNameMap: { [name: string]: protos.IExecutionNode } = {};
      allNodes.forEach(node => (nodeNameMap[node.name] = node));

      // Determine which nodes should be included.
      var includedNodeNames =
        this.runConfig.nodes && this.runConfig.nodes.length > 0
          ? utils.matchPatterns(this.runConfig.nodes, allNodeNames)
          : allNodeNames;
      var includedNodes = allNodes.filter(node => includedNodeNames.indexOf(node.name) >= 0);
      if (this.runConfig.includeDependencies) {
        // Compute all transitive dependencies.
        for (let i = 0; i < allNodes.length; i++) {
          includedNodes.forEach(node => {
            var matchingNodeNames =
              node.dependencies && node.dependencies.length > 0
                ? utils.matchPatterns(node.dependencies, allNodeNames)
                : [];
            // Update included node names.
            matchingNodeNames.forEach(nodeName => {
              if (includedNodeNames.indexOf(nodeName) < 0) {
                includedNodeNames.push(nodeName);
              }
            });
            // Update included nodes.
            includedNodes = allNodes.filter(node => includedNodeNames.indexOf(node.name) >= 0);
          });
        }
      }
      // Remove any excluded dependencies and evaluate wildcard dependencies.
      includedNodes.forEach(node => {
        node.dependencies = utils.matchPatterns(node.dependencies, includedNodeNames);
      });
      return {
        projectConfig: this.compiledGraph.projectConfig,
        runConfig: this.runConfig,
        nodes: includedNodes
      };
    });
  }

  buildMaterialization(m: protos.IMaterialization, table: protos.ITable) {
    return protos.ExecutionNode.create({
      name: m.name,
      dependencies: m.dependencies,
      tasks: ([] as protos.IExecutionTask[]).concat(
        m.pres.map(pre => ({ statement: pre })),
        this.adapter.buildTasks(m, this.runConfig, table).build(),
        m.posts.map(post => ({ statement: post })),
        m.assertions.map(assertion => ({
          statement: assertion,
          type: "assertion"
        }))
      )
    });
  }

  buildOperation(operation: protos.IOperation) {
    return protos.ExecutionNode.create({
      name: operation.name,
      dependencies: operation.dependencies,
      tasks: operation.statements.map(statement => ({
        type: "statement",
        statement: statement
      }))
    });
  }

  buildAssertion(assertion: protos.IAssertion) {
    return protos.ExecutionNode.create({
      name: assertion.name,
      dependencies: assertion.dependencies,
      tasks: assertion.queries.map(query => ({
        type: "assertion",
        statement: query
      }))
    });
  }
}
